/**
 * Shared webhook pipeline used by both the real PayPal webhook endpoint and
 * the local demo simulator. Verifies signature (live), persists the event,
 * runs the agent, and returns an HTTP-style result.
 */
import { runChurnAgent } from "./agent/run";
import type { ChurnEventType } from "./agent/strategy";
import type { AppConfig } from "./config";
import type { ChurnStore } from "../db/store";
import type { PayPalGateway, WebhookHeaders } from "./paypal/types";

export const HANDLED_EVENT_TYPES = [
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
] as const;

export function isHandledEventType(type: string): type is ChurnEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

export interface WebhookInput {
  headers: WebhookHeaders;
  rawBody: string;
  /** Set by the demo simulator so mock mode can distinguish signed traffic. */
  source?: "demo" | "paypal";
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handlePayPalWebhook(
  store: ChurnStore,
  gateway: PayPalGateway,
  config: AppConfig,
  input: WebhookInput,
): Promise<WebhookResult> {
  let parsed: { event_type?: string; resource?: { id?: string } };
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  const eventType = parsed.event_type ?? "";
  const resourceId = parsed.resource?.id ?? "";

  if (!isHandledEventType(eventType) || !resourceId) {
    return { status: 200, body: { ignored: true, reason: `unhandled event_type ${eventType}` } };
  }

  // Signature verification: real PayPal verification in live mode; mock gateway
  // accepts everything (documented in ARCHITECTURE.md).
  if (!config.mockMode && input.source !== "demo") {
    let ok = false;
    try {
      ok = await gateway.verifyWebhook(input.headers, input.rawBody);
    } catch (err) {
      return {
        status: 500,
        body: { error: "verification failure", detail: String(err) },
      };
    }
    if (!ok) return { status: 400, body: { error: "webhook signature verification failed" } };
  }

  const event = store.createEvent({
    subscription_id: null,
    type: eventType,
    payload: input.rawBody,
    status: "received",
  });

  const outcome = await runChurnAgent(store, gateway, {
    eventId: event.id,
    eventType,
    paypalSubscriptionId: resourceId,
  });

  return {
    status: 200,
    body: {
      received: true,
      eventId: event.id,
      agentStatus: outcome.status,
      segment: outcome.segment,
      offerToken: outcome.offer?.token ?? null,
      offerUrl: outcome.offerUrl,
      trace: outcome.trace,
    },
  };
}
