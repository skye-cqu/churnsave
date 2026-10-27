/**
 * ChurnSave agent — the closed loop:
 *   webhook event -> fetch buyer history (Transaction Search) -> segment ->
 *   LLM buyer portrait -> decide offer -> LLM reasoning review ->
 *   persist offer with one-click accept URL.
 *
 * The rule engine (strategy.ts) remains the decision authority; the LLM layer
 * (llm.ts) only annotates it (portrait + reasoning). Every LLM step degrades to
 * deterministic rule text on failure/timeout, so the loop never blocks on AI.
 */
import { Graph, type AgentState } from "./graph";
import {
  computeBuyerStats,
  decideOffer,
  recoveredMonthlyMrr,
  segmentBuyer,
  type ChurnEventType,
  type Segment,
} from "./strategy";
import {
  createLlmProvider,
  loadLlmConfig,
  localBuyerProfile,
  localOfferReasoning,
  type LlmProvider,
} from "./llm";
import type { PayPalGateway } from "../paypal/types";
import type { ChurnStore, OfferRow, Subscription } from "../../db/store";

export interface AgentContext extends AgentState {
  store: ChurnStore;
  gateway: PayPalGateway;
  llm: LlmProvider;
  event: { eventId: string; eventType: ChurnEventType; paypalSubscriptionId: string };
  subscription: Subscription | null;
  segment: Segment | null;
  offer: OfferRow | null;
  offerUrl: string | null;
  buyerProfile: string | null;
  error?: string;
}

export interface AgentOutcome {
  eventId: string;
  status: "offer_created" | "no_offer" | "ignored" | "error";
  segment: Segment | null;
  offer: OfferRow | null;
  offerUrl: string | null;
  buyerProfile: string | null;
  aiProvider: string | null;
  trace: string[];
}

function buildGraph(ctx: AgentContext): Graph<AgentContext> {
  const graph = new Graph<AgentContext>();

  graph
    .addNode("findSubscription", async (s) => {
      s.subscription =
        s.store.getSubscriptionByPaypalId(s.event.paypalSubscriptionId) ?? null;
      if (!s.subscription) s.error = `unknown subscription ${s.event.paypalSubscriptionId}`;
    })
    .addNode("fetchBuyerHistory", async (s) => {
      if (!s.subscription || s.error) return;
      const end = new Date();
      const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
      const txs = await s.gateway.searchTransactions({
        subscriptionId: s.subscription.paypal_subscription_id,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });
      // MVP keeps local transaction mirror in sync with gateway results.
      s.trace.push(`history:${txs.length}`);
      (s as AgentContext & { fetchedTxs?: number }).fetchedTxs = txs.length;
    })
    .addNode("segmentBuyer", async (s) => {
      if (!s.subscription || s.error) return;
      const txs = s.store.getTransactions(s.subscription.id);
      const stats = computeBuyerStats(
        txs.map((t) => ({
          transaction_id: t.id,
          transaction_status: "S",
          transaction_amount: { currency_code: t.currency, value: String(t.amount) },
          transaction_initiation_date: t.paid_at,
        })),
      );
      s.segment = segmentBuyer(stats);
      s.trace.push(
        stats
          ? `ltv:${stats.ltv} payments:${stats.paymentCount} -> ${s.segment}`
          : "no-history -> unknown",
      );
    })
    .addNode("summarizeBuyerHistory", async (s) => {
      // LLM reasoning step 1: transactions -> natural-language buyer portrait.
      if (!s.subscription || s.error) return;
      if (!s.llm.enabled) {
        s.trace.push("llm:disabled");
        return;
      }
      const txs = s.store.getTransactions(s.subscription.id);
      const input = {
        buyerName: s.subscription.buyer_name,
        plan: s.subscription.plan,
        segment: s.segment ?? "unknown",
        stats: computeBuyerStats(
          txs.map((t) => ({
            transaction_id: t.id,
            transaction_status: "S",
            transaction_amount: { currency_code: t.currency, value: String(t.amount) },
            transaction_initiation_date: t.paid_at,
          })),
        ),
        transactions: txs.map((t) => ({
          amount: t.amount,
          currency: t.currency,
          paid_at: t.paid_at,
        })),
      };
      const res = await s.llm.summarizeBuyerHistory(input);
      if (res.ok && res.data) {
        s.buyerProfile = res.data;
        s.trace.push(`llm:profile:${res.provider}`);
      } else {
        s.buyerProfile = localBuyerProfile(input);
        s.trace.push(`llm:profile:fallback(${res.error ?? "unknown"})`);
      }
    })
    .addNode("decideOffer", async (s) => {
      if (!s.subscription || s.error) return;
      const draft = decideOffer({
        segment: s.segment ?? "unknown",
        eventType: s.event.eventType,
        monthlyPrice: s.subscription.monthly_price,
        currency: s.subscription.currency,
      });
      if (!draft) {
        s.trace.push("decision:no-offer");
        return;
      }
      s.trace.push(`decision:${draft.kind} -${draft.discountPercent}%`);
      const token = crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      s.offer = s.store.createOffer({
        event_id: s.event.eventId,
        subscription_id: s.subscription.id,
        token,
        kind: draft.kind,
        title: draft.title,
        message: draft.message,
        discount_percent: draft.discountPercent,
        discount_months: draft.discountMonths,
        new_plan: draft.newPlan ?? null,
        new_price: draft.newPrice ?? null,
        original_price: draft.originalPrice,
        offer_price: draft.offerPrice,
        currency: s.subscription.currency,
        expires_at: expires,
      });
      s.offerUrl = `/offers/${token}`;
      s.trace.push(
        `offer saved: ${recoveredMonthlyMrr(draft)} ${s.subscription.currency}/mo retained if accepted`,
      );
    })
    .addNode("decideOfferReasoning", async (s) => {
      // LLM reasoning step 2: review the rule-offer candidate and produce a
      // one-sentence personalized rationale. Failure/timeout -> rule copy.
      if (!s.offer || !s.subscription || s.error) return;
      const input = {
        buyerName: s.subscription.buyer_name,
        plan: s.subscription.plan,
        segment: s.segment ?? "unknown",
        eventType: s.event.eventType,
        offer: {
          kind: s.offer.kind,
          title: s.offer.title,
          discountPercent: s.offer.discount_percent,
          offerPrice: s.offer.offer_price,
          originalPrice: s.offer.original_price,
          currency: s.offer.currency,
          newPlan: s.offer.new_plan ?? undefined,
        },
        profile: s.buyerProfile,
      };
      if (!s.llm.enabled) {
        // Pure-rules mode: createOffer already stored the rule copy under
        // provider "rules"; no LLM reasoning step is recorded at all.
        return;
      }
      const res = await s.llm.decideOfferReasoning(input);
      if (res.ok && res.data) {
        s.store.setOfferAi(s.offer.id, {
          reasoning: res.data.reasoning,
          provider: res.provider,
          model: res.model,
          confidence: res.data.confidence,
          profile: s.buyerProfile,
        });
        // keep the in-memory row consistent with what was persisted
        s.offer.ai_reasoning = res.data.reasoning;
        s.offer.ai_provider = res.provider;
        s.offer.ai_model = res.model;
        s.offer.ai_confidence = res.data.confidence;
        s.offer.ai_profile = s.buyerProfile;
        s.trace.push(`llm:reasoning:${res.provider}(conf:${res.data.confidence.toFixed(2)})`);
      } else {
        const fallback = localOfferReasoning(input);
        s.store.setOfferAi(s.offer.id, {
          reasoning: fallback.reasoning,
          provider: "rules",
          model: null,
          confidence: fallback.confidence,
          profile: s.buyerProfile,
        });
        s.offer.ai_reasoning = fallback.reasoning;
        s.offer.ai_provider = "rules";
        s.offer.ai_confidence = fallback.confidence;
        s.offer.ai_profile = s.buyerProfile;
        s.trace.push(`llm:reasoning:fallback(${res.error ?? "unknown"})`);
      }
    });

  return graph
    .setEntryPoint("findSubscription")
    .addEdge("findSubscription", "fetchBuyerHistory")
    .addEdge("fetchBuyerHistory", "segmentBuyer")
    .addEdge("segmentBuyer", "summarizeBuyerHistory")
    .addEdge("summarizeBuyerHistory", "decideOffer")
    .addEdge("decideOffer", "decideOfferReasoning");
}

/** Run the agent for one billing webhook event and persist its outcome. */
export async function runChurnAgent(
  store: ChurnStore,
  gateway: PayPalGateway,
  input: { eventId: string; eventType: ChurnEventType; paypalSubscriptionId: string },
  llm: LlmProvider = createLlmProvider(loadLlmConfig()),
): Promise<AgentOutcome> {
  const ctx: AgentContext = {
    store,
    gateway,
    llm,
    event: input,
    subscription: null,
    segment: null,
    offer: null,
    offerUrl: null,
    buyerProfile: null,
    trace: [],
  };
  store.setEventStatus(input.eventId, "processing");
  try {
    await buildGraph(ctx).run(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.trace.push(`error:${message}`);
    store.setEventStatus(input.eventId, "error", { agentTrace: ctx.trace, error: message });
    return {
      eventId: input.eventId,
      status: "error",
      segment: ctx.segment,
      offer: null,
      offerUrl: null,
      buyerProfile: null,
      aiProvider: null,
      trace: ctx.trace,
    };
  }

  if (ctx.error) {
    store.setEventStatus(input.eventId, "ignored", { agentTrace: ctx.trace, error: ctx.error });
    return {
      eventId: input.eventId,
      status: "ignored",
      segment: null,
      offer: null,
      offerUrl: null,
      buyerProfile: null,
      aiProvider: null,
      trace: ctx.trace,
    };
  }

  if (ctx.offer) {
    store.setEventStatus(input.eventId, "offer_created", { agentTrace: ctx.trace });
    return {
      eventId: input.eventId,
      status: "offer_created",
      segment: ctx.segment,
      offer: ctx.offer,
      offerUrl: ctx.offerUrl,
      buyerProfile: ctx.buyerProfile,
      aiProvider: ctx.offer.ai_provider,
      trace: ctx.trace,
    };
  }

  store.setEventStatus(input.eventId, "no_offer", { agentTrace: ctx.trace });
  return {
    eventId: input.eventId,
    status: "no_offer",
    segment: ctx.segment,
    offer: null,
    offerUrl: null,
    buyerProfile: ctx.buyerProfile,
    aiProvider: null,
    trace: ctx.trace,
  };
}
