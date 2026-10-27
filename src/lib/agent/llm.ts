/**
 * LLM decision layer for ChurnSave.
 *
 * The rule engine (strategy.ts) stays the source of truth for *what* offer a
 * buyer gets; the LLM layer adds two reasoning steps on top:
 *
 *   1. summarizeBuyerHistory  — transactions → natural-language buyer portrait
 *   2. decideOfferReasoning   — rule-offer candidate → one-sentence personalized
 *                               rationale + confidence, shown to buyers/merchants
 *
 * Providers:
 *   - MockProvider  (default): deterministic offline mirror of the rules. Tests
 *     and credential-less runs use it, so the closed loop never needs network.
 *   - NebiusProvider: OpenAI-compatible /chat/completions against Nebius Token
 *     Factory (default model nvidia/llama-3.1-nemotron-70b-instruct). Any other
 *     OpenAI-compatible endpoint works via OPENAI_COMPAT_BASE_URL.
 *
 * Failure policy: every LLM call is bounded (3s timeout by default) and every
 * failure — no key, disabled, timeout, HTTP error, unparseable JSON — degrades
 * to the deterministic rule copy. The retention loop must never block on AI.
 */

import type { BuyerStats, ChurnEventType, Segment } from "./strategy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmResult<T> {
  ok: boolean;
  /** Parsed payload when ok. */
  data?: T;
  /** "mock" | "nebius" */
  provider: string;
  /** Model identifier (or "mock/deterministic" for the mock provider). */
  model: string;
  /** Set when !ok: "disabled" | "no-key" | "timeout" | "http 500" | "parse" | ... */
  error?: string;
  latencyMs: number;
}

export interface BuyerHistoryInput {
  buyerName: string;
  plan: string;
  segment: Segment;
  stats: BuyerStats | null;
  /** Paid transactions, chronological. */
  transactions: { amount: number; currency: string; paid_at: string }[];
}

export interface OfferReasoningInput {
  buyerName: string;
  plan: string;
  segment: Segment;
  eventType: ChurnEventType;
  /** Rule-engine draft that the LLM reviews and annotates. */
  offer: {
    kind: "discount" | "downgrade";
    title: string;
    discountPercent: number;
    offerPrice: number;
    originalPrice: number;
    currency: string;
    newPlan?: string;
  };
  /** Optional buyer portrait from summarizeBuyerHistory. */
  profile?: string | null;
}

export interface OfferReasoning {
  /** One-sentence personalized rationale, safe to show the buyer. */
  reasoning: string;
  /** 0..1 */
  confidence: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** False when the whole LLM layer is switched off (LLM_ENABLED=false). */
  readonly enabled: boolean;
  summarizeBuyerHistory(input: BuyerHistoryInput): Promise<LlmResult<string>>;
  decideOfferReasoning(input: OfferReasoningInput): Promise<LlmResult<OfferReasoning>>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_NEBIUS_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";
export const DEFAULT_NEBIUS_BASE_URL = "https://api.studio.nebius.ai/v1";
export const DEFAULT_LLM_TIMEOUT_MS = 3_000;

export interface LlmConfig {
  /** Master switch; false => pure rules, no LLM calls at all. */
  enabled: boolean;
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const enabled = !(env.LLM_ENABLED === "false" || env.LLM_ENABLED === "0");
  const apiKey = env.NEBIUS_API_KEY?.trim() || undefined;
  return {
    enabled,
    apiKey,
    model: env.NEBIUS_MODEL?.trim() || DEFAULT_NEBIUS_MODEL,
    // OPENAI_COMPAT_BASE_URL generalizes to any OpenAI-compatible endpoint.
    baseUrl:
      env.OPENAI_COMPAT_BASE_URL?.trim() ||
      env.NEBIUS_BASE_URL?.trim() ||
      DEFAULT_NEBIUS_BASE_URL,
    timeoutMs: Number(env.NEBIUS_TIMEOUT_MS) > 0 ? Number(env.NEBIUS_TIMEOUT_MS) : DEFAULT_LLM_TIMEOUT_MS,
  };
}

/** Pick the provider for a config: Nebius when a key exists, Mock otherwise. */
export function createLlmProvider(
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
): LlmProvider {
  if (!config.enabled) return new MockProvider({ enabled: false });
  if (config.apiKey) return new NebiusProvider(config, fetchImpl);
  return new MockProvider({ enabled: true });
}

// ---------------------------------------------------------------------------
// Deterministic fallbacks (shared by MockProvider and every degradation path)
// ---------------------------------------------------------------------------

function money(v: number, currency: string): string {
  return currency === "USD" ? `$${v.toFixed(2)}` : `${currency} ${v.toFixed(2)}`;
}

const SEGMENT_PORTRAIT: Record<Segment, string> = {
  champion: "High-LTV, loyal customer — worth a meaningful retention incentive.",
  steady: "Consistent mid-value subscriber — a short discount likely keeps them.",
  light: "Low-spend account — a cheaper plan beats losing them entirely.",
  unknown: "No payment history yet — a gentle nudge is the safe play.",
};

/** Natural-language buyer portrait, computed locally with zero network. */
export function localBuyerProfile(input: BuyerHistoryInput): string {
  const { buyerName, plan, segment, stats } = input;
  if (!stats) {
    return `${buyerName} has no PayPal payment history yet — first-cycle subscriber on the ${plan} plan. ${SEGMENT_PORTRAIT.unknown}`;
  }
  return (
    `${buyerName} (on ${plan}): ${stats.paymentCount} PayPal payment${stats.paymentCount === 1 ? "" : "s"} ` +
    `totaling ${money(stats.ltv, stats.currency)} over ~${stats.tenureMonths} month${stats.tenureMonths === 1 ? "" : "s"} ` +
    `(avg ${money(stats.monthlyAvg, stats.currency)}/mo). ${SEGMENT_PORTRAIT[segment]}`
  );
}

const SEGMENT_CONFIDENCE: Record<Segment, number> = {
  champion: 0.86,
  steady: 0.8,
  light: 0.75,
  unknown: 0.6,
};

/** Rule-mirroring rationale used by MockProvider and LLM failure fallbacks. */
export function localOfferReasoning(input: OfferReasoningInput): OfferReasoning {
  const { buyerName, segment, eventType, offer } = input;
  const sym = money(offer.offerPrice, offer.currency).trim();
  const what =
    offer.kind === "downgrade"
      ? `a Starter downgrade at ${sym}/mo`
      : `${offer.discountPercent}% off (next cycle ${sym})`;
  const why =
    eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
      ? "their payment failed through no intent to leave, so a small rescue discount is enough"
      : SEGMENT_PORTRAIT[segment].toLowerCase();
  return {
    reasoning:
      `${buyerName} matches the "${segment}" segment and ${why}; ` +
      `offering ${what} is the cheapest credible way to retain ~${money(offer.offerPrice, offer.currency)}/mo of MRR.`,
    confidence: SEGMENT_CONFIDENCE[segment],
  };
}

// ---------------------------------------------------------------------------
// MockProvider — deterministic, offline, used by tests and key-less runs
// ---------------------------------------------------------------------------

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock/deterministic";
  readonly enabled: boolean;

  constructor(opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? true;
  }

  private result<T>(data: T): LlmResult<T> {
    return { ok: true, data, provider: this.name, model: this.model, latencyMs: 0 };
  }

  private disabled<T>(): LlmResult<T> {
    return { ok: false, provider: this.name, model: this.model, error: "disabled", latencyMs: 0 };
  }

  async summarizeBuyerHistory(input: BuyerHistoryInput): Promise<LlmResult<string>> {
    if (!this.enabled) return this.disabled<string>();
    return this.result(localBuyerProfile(input));
  }

  async decideOfferReasoning(input: OfferReasoningInput): Promise<LlmResult<OfferReasoning>> {
    if (!this.enabled) return this.disabled<OfferReasoning>();
    return this.result(localOfferReasoning(input));
  }
}

// ---------------------------------------------------------------------------
// NebiusProvider — OpenAI-compatible chat completions with JSON-schema output
// ---------------------------------------------------------------------------

const PROFILE_SCHEMA = { type: "object", properties: { profile: { type: "string" } }, required: ["profile"] };
const REASONING_SCHEMA = {
  type: "object",
  properties: { reasoning: { type: "string" }, confidence: { type: "number" } },
  required: ["reasoning", "confidence"],
};

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class NebiusProvider implements LlmProvider {
  readonly name = "nebius";
  readonly model: string;
  readonly enabled = true;

  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }

  private async chatJson<T>(
    system: string,
    user: string,
    schema: Record<string, unknown>,
    validate: (obj: Record<string, unknown>) => T | null,
  ): Promise<LlmResult<T>> {
    const started = Date.now();
    const done = <T2>(r: Omit<LlmResult<T2>, "provider" | "model" | "latencyMs">): LlmResult<T2> => ({
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
      ...r,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.3,
          max_tokens: 300,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                `${system}\nRespond with ONLY a JSON object matching this schema: ` +
                JSON.stringify(schema),
            },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return done({ ok: false, error: aborted ? "timeout" : `network: ${String(err)}` });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return done({ ok: false, error: `http ${res.status}` });
    let payload: ChatCompletionResponse;
    try {
      payload = (await res.json()) as ChatCompletionResponse;
    } catch {
      return done({ ok: false, error: "parse" });
    }
    const content = payload.choices?.[0]?.message?.content ?? "";
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return done({ ok: false, error: "parse" });
    }
    const data = validate(obj);
    if (!data) return done({ ok: false, error: "parse" });
    return done({ ok: true, data });
  }

  async summarizeBuyerHistory(input: BuyerHistoryInput): Promise<LlmResult<string>> {
    return this.chatJson<string>(
      "You are the analytics step of a subscription churn-recovery agent. " +
        "Write a 1-2 sentence factual buyer portrait from the transaction history.",
      JSON.stringify({
        buyerName: input.buyerName,
        plan: input.plan,
        segment: input.segment,
        stats: input.stats,
        payments: input.transactions.slice(-12),
      }),
      PROFILE_SCHEMA,
      (obj) => (typeof obj.profile === "string" && obj.profile.trim() ? obj.profile.trim() : null),
    );
  }

  async decideOfferReasoning(input: OfferReasoningInput): Promise<LlmResult<OfferReasoning>> {
    return this.chatJson<OfferReasoning>(
      "You are the decision-review step of a subscription churn-recovery agent. " +
        "A rule engine already picked the offer. In ONE buyer-friendly sentence explain " +
        "why this specific offer fits this specific buyer. Be concrete, honest, no hype.",
      JSON.stringify(input),
      REASONING_SCHEMA,
      (obj) => {
        if (typeof obj.reasoning !== "string" || !obj.reasoning.trim()) return null;
        const confidence = Number(obj.confidence);
        if (!Number.isFinite(confidence)) return null;
        return {
          reasoning: obj.reasoning.trim(),
          confidence: Math.min(1, Math.max(0, confidence)),
        };
      },
    );
  }
}
