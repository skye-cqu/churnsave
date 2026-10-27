import { getConfig, getGateway, getLlm, getStore } from "@/lib/runtime";
import { handlePayPalWebhook } from "@/lib/webhook";

/**
 * Demo helper: fires a synthetic PayPal webhook at the same pipeline the real
 * integration uses. Lets judges (and the 90s video) trigger churn events
 * without a live PayPal developer account.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    paypalSubscriptionId?: string;
    eventType?: string;
  };
  const store = getStore();
  const sub = body.paypalSubscriptionId
    ? store.getSubscriptionByPaypalId(body.paypalSubscriptionId)
    : undefined;
  if (!sub) {
    return Response.json({ error: "unknown paypalSubscriptionId" }, { status: 400 });
  }
  const eventType = body.eventType ?? "BILLING.SUBSCRIPTION.CANCELLED";
  const rawBody = JSON.stringify({
    id: `WH-DEMO-${Date.now()}`,
    event_version: "1.0",
    event_type: eventType,
    resource_type: "subscription",
    resource: {
      id: sub.paypal_subscription_id,
      subscriber: { email_address: sub.buyer_email, name: { given_name: sub.buyer_name } },
    },
  });
  const result = await handlePayPalWebhook(store, getGateway(), getConfig(), {
    headers: { "content-type": "application/json" },
    rawBody,
    source: "demo",
  }, getLlm());
  return Response.json({ ...result.body, subscription: sub.buyer_name }, { status: result.status });
}
