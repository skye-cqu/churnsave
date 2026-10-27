/**
 * LLM decision-layer tests — fully offline.
 * Covers: MockProvider determinism, provider selection/config, NebiusProvider
 * request construction + JSON-schema parsing + degradation (http error, bad
 * JSON, timeout) against a stubbed fetch, and the closed-loop integration
 * (mock loop unchanged, fallback paths never block the funnel).
 */
import { describe, expect, it, vi } from "vitest";
import { ChurnStore } from "../src/db/store";
import { seedDemoData } from "../src/db/seed-data";
import { loadConfig } from "../src/lib/config";
import { MockPayPalGateway } from "../src/lib/paypal/mock";
import {
  DEFAULT_NEBIUS_BASE_URL,
  DEFAULT_NEBIUS_MODEL,
  MockProvider,
  NebiusProvider,
  createLlmProvider,
  loadLlmConfig,
  localBuyerProfile,
  type BuyerHistoryInput,
  type OfferReasoningInput,
} from "../src/lib/agent/llm";
import { handlePayPalWebhook } from "../src/lib/webhook";
import { acceptOffer } from "../src/lib/recover";

function historyInput(): BuyerHistoryInput {
  return {
    buyerName: "Ava Chen",
    plan: "Pro",
    segment: "champion",
    stats: { ltv: 588, currency: "USD", paymentCount: 12, tenureMonths: 12, monthlyAvg: 49 },
    transactions: Array.from({ length: 12 }, (_, i) => ({
      amount: 49,
      currency: "USD",
      paid_at: new Date(Date.now() - (11 - i) * 30 * 86_400_000).toISOString(),
    })),
  };
}

function reasoningInput(): OfferReasoningInput {
  return {
    buyerName: "Ava Chen",
    plan: "Pro",
    segment: "champion",
    eventType: "BILLING.SUBSCRIPTION.CANCELLED",
    offer: {
      kind: "discount",
      title: "20% off for 3 months",
      discountPercent: 20,
      offerPrice: 39.2,
      originalPrice: 49,
      currency: "USD",
    },
    profile: "Ava Chen (on Pro): 12 PayPal payments totaling $588.00.",
  };
}

describe("MockProvider (default, deterministic, offline)", () => {
  it("summarizes buyer history into a stable portrait", async () => {
    const p = new MockProvider();
    const r1 = await p.summarizeBuyerHistory(historyInput());
    const r2 = await p.summarizeBuyerHistory(historyInput());
    expect(r1.ok).toBe(true);
    expect(r1.provider).toBe("mock");
    expect(r1.data).toBe(r2.data); // deterministic
    expect(r1.data).toContain("Ava Chen");
    expect(r1.data).toContain("$588.00");
    expect(r1.data).toContain("12");
  });

  it("produces reasoning + confidence constrained to 0..1", async () => {
    const p = new MockProvider();
    const r = await p.decideOfferReasoning(reasoningInput());
    expect(r.ok).toBe(true);
    expect(r.data!.reasoning).toContain("Ava Chen");
    expect(r.data!.reasoning).toContain("20% off");
    expect(r.data!.confidence).toBeGreaterThan(0);
    expect(r.data!.confidence).toBeLessThanOrEqual(1);
  });

  it("handles buyers with no history", async () => {
    const p = new MockProvider();
    const r = await p.summarizeBuyerHistory({ ...historyInput(), stats: null, segment: "unknown", transactions: [] });
    expect(r.ok).toBe(true);
    expect(r.data).toContain("no PayPal payment history");
  });

  it("reports disabled when the LLM layer is switched off", async () => {
    const p = new MockProvider({ enabled: false });
    expect(p.enabled).toBe(false);
    const r = await p.decideOfferReasoning(reasoningInput());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("disabled");
  });
});

describe("LLM config + provider selection", () => {
  it("defaults to the Nebius endpoint and NVIDIA open model", () => {
    const cfg = loadLlmConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe(DEFAULT_NEBIUS_MODEL);
    expect(cfg.baseUrl).toBe(DEFAULT_NEBIUS_BASE_URL);
    expect(cfg.timeoutMs).toBe(3000);
  });

  it("LLM_ENABLED=false switches the whole layer off", () => {
    expect(loadLlmConfig({ LLM_ENABLED: "false" }).enabled).toBe(false);
    expect(loadLlmConfig({ LLM_ENABLED: "0" }).enabled).toBe(false);
    expect(loadLlmConfig({ LLM_ENABLED: "true" }).enabled).toBe(true);
  });

  it("no key -> MockProvider; key -> NebiusProvider; env overrides honored", () => {
    expect(createLlmProvider(loadLlmConfig({})).name).toBe("mock");
    const nebius = createLlmProvider(loadLlmConfig({ NEBIUS_API_KEY: "k" }));
    expect(nebius.name).toBe("nebius");
    expect(nebius.model).toBe(DEFAULT_NEBIUS_MODEL);
    const custom = createLlmProvider(
      loadLlmConfig({
        NEBIUS_API_KEY: "k",
        NEBIUS_MODEL: "meta/llama-3.3-70b-instruct",
        OPENAI_COMPAT_BASE_URL: "https://integrations.nexus.start.nebius.cloud/v1",
      }),
    );
    expect(custom.model).toBe("meta/llama-3.3-70b-instruct");
    expect(loadLlmConfig({ OPENAI_COMPAT_BASE_URL: "https://x/v1" }).baseUrl).toBe("https://x/v1");
    expect(loadLlmConfig({ NEBIUS_BASE_URL: "https://y/v1" }).baseUrl).toBe("https://y/v1");
  });
});

describe("NebiusProvider (stubbed fetch)", () => {
  const cfg = loadLlmConfig({ NEBIUS_API_KEY: "test-key", NEBIUS_TIMEOUT_MS: "200" });

  function stubFetch(content: string | null, opts: { status?: number; reject?: boolean } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (opts.reject) {
        // honor abort so the timeout path can fire
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      const body =
        content === null ? "not json at all" : JSON.stringify({ choices: [{ message: { content } }] });
      return {
        ok: (opts.status ?? 200) < 400,
        status: opts.status ?? 200,
        json: async () => JSON.parse(body),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("constructs an OpenAI-compatible chat completion with JSON schema", async () => {
    const { fetchImpl, calls } = stubFetch(
      JSON.stringify({ reasoning: "Fits Ava.", confidence: 0.9 }),
    );
    const p = new NebiusProvider(cfg, fetchImpl);
    const r = await p.decideOfferReasoning(reasoningInput());
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("nebius");
    expect(r.data).toEqual({ reasoning: "Fits Ava.", confidence: 0.9 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_NEBIUS_BASE_URL}/chat/completions`);
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe(DEFAULT_NEBIUS_MODEL);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain('"confidence"'); // schema embedded
    expect(JSON.parse(body.messages[1].content).buyerName).toBe("Ava Chen");
  });

  it("clamps confidence into 0..1", async () => {
    const { fetchImpl } = stubFetch(JSON.stringify({ reasoning: "R", confidence: 1.7 }));
    const p = new NebiusProvider(cfg, fetchImpl);
    const r = await p.decideOfferReasoning(reasoningInput());
    expect(r.ok).toBe(true);
    expect(r.data!.confidence).toBe(1);
  });

  it("degrades on unparseable model JSON (parse error)", async () => {
    const { fetchImpl } = stubFetch("this is not json");
    const p = new NebiusProvider(cfg, fetchImpl);
    const r = await p.summarizeBuyerHistory(historyInput());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("parse");
  });

  it("degrades on schema-mismatched JSON", async () => {
    const { fetchImpl } = stubFetch(JSON.stringify({ reasoning: 42, confidence: "high" }));
    const p = new NebiusProvider(cfg, fetchImpl);
    const r = await p.summarizeBuyerHistory(historyInput());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("parse");
  });

  it("degrades on HTTP errors", async () => {
    const { fetchImpl } = stubFetch(null, { status: 500 });
    const p = new NebiusProvider(cfg, fetchImpl);
    const r = await p.summarizeBuyerHistory(historyInput());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("http 500");
  });

  it("degrades on timeout (bounded, never hangs)", async () => {
    const { fetchImpl } = stubFetch(null, { reject: true });
    const p = new NebiusProvider({ ...cfg, timeoutMs: 30 }, fetchImpl);
    const r = await p.summarizeBuyerHistory(historyInput());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout");
    expect(r.latencyMs).toBeLessThan(2000);
  });
});

describe("closed loop with LLM layer (offline)", () => {
  function webhookBody(paypalSubscriptionId: string, eventType: string): string {
    return JSON.stringify({
      id: `WH-${Math.random()}`,
      event_type: eventType,
      resource: { id: paypalSubscriptionId },
    });
  }

  it("mock provider annotates the offer; loop result unchanged", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const res = await handlePayPalWebhook(
      store, new MockPayPalGateway(), loadConfig({}),
      { headers: {}, rawBody: webhookBody("I-DEMO_CHAMPION_01", "BILLING.SUBSCRIPTION.CANCELLED"), source: "demo" },
      new MockProvider(),
    );
    expect(res.body.agentStatus).toBe("offer_created");
    const offer = store.getOfferByToken(res.body.offerToken as string)!;
    expect(offer.discount_percent).toBe(20); // rules still own the decision
    expect(offer.ai_provider).toBe("mock");
    expect(offer.ai_reasoning).toContain("Ava Chen");
    expect(offer.ai_confidence).toBeGreaterThan(0);
    expect(offer.ai_profile).toContain("Ava Chen");
    const trace: string[] = JSON.parse(store.getEvent(res.body.eventId as string)!.agent_trace!);
    expect(trace).toContain("llm:profile:mock");
    expect(trace.some((t) => t.startsWith("llm:reasoning:mock"))).toBe(true);
    // accepting still works end to end
    const result = await acceptOffer(store, new MockPayPalGateway(), offer.token);
    expect(result.monthlyMrr).toBe(39.2);
  });

  it("LLM failure degrades to rule copy and never blocks the loop", async () => {
    const failing = new MockProvider();
    vi.spyOn(failing, "summarizeBuyerHistory").mockResolvedValue({
      ok: false, provider: "nebius", model: DEFAULT_NEBIUS_MODEL, error: "timeout", latencyMs: 3000,
    });
    vi.spyOn(failing, "decideOfferReasoning").mockResolvedValue({
      ok: false, provider: "nebius", model: DEFAULT_NEBIUS_MODEL, error: "http 503", latencyMs: 120,
    });
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const res = await handlePayPalWebhook(
      store, new MockPayPalGateway(), loadConfig({}),
      { headers: {}, rawBody: webhookBody("I-DEMO_LIGHT_03", "BILLING.SUBSCRIPTION.CANCELLED"), source: "demo" },
      failing,
    );
    expect(res.body.agentStatus).toBe("offer_created"); // loop unblocked
    const offer = store.getOfferByToken(res.body.offerToken as string)!;
    expect(offer.kind).toBe("downgrade"); // rules decided as usual
    expect(offer.ai_provider).toBe("rules");
    expect(offer.ai_reasoning).toContain("Chloe Park");
    const trace: string[] = JSON.parse(store.getEvent(res.body.eventId as string)!.agent_trace!);
    expect(trace).toContain("llm:profile:fallback(timeout)");
    expect(trace).toContain("llm:reasoning:fallback(http 503)");
  });

  it("LLM_ENABLED=false runs pure rules: no llm trace steps, rule copy on the offer", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const res = await handlePayPalWebhook(
      store, new MockPayPalGateway(), loadConfig({}),
      { headers: {}, rawBody: webhookBody("I-DEMO_STEADY_02", "BILLING.SUBSCRIPTION.CANCELLED"), source: "demo" },
      new MockProvider({ enabled: false }),
    );
    expect(res.body.agentStatus).toBe("offer_created");
    const offer = store.getOfferByToken(res.body.offerToken as string)!;
    expect(offer.ai_provider).toBe("rules");
    expect(offer.ai_reasoning).toBe(offer.message); // pure rule copy
    const trace: string[] = JSON.parse(store.getEvent(res.body.eventId as string)!.agent_trace!);
    expect(trace).toContain("llm:disabled");
    expect(trace.some((t) => t.startsWith("llm:reasoning"))).toBe(false);
  });

  it("localBuyerProfile is a deterministic fallback for both mock and degradation", () => {
    const text = localBuyerProfile(historyInput());
    expect(text).toContain("$588.00");
    expect(localBuyerProfile(historyInput())).toBe(text);
  });
});
