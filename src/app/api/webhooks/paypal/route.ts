import { getConfig, getGateway, getLlm, getStore } from "@/lib/runtime";
import { handlePayPalWebhook } from "@/lib/webhook";

/**
 * Real PayPal webhook entry point.
 * Configure in the PayPal developer dashboard to point at
 *   https://<host>/api/webhooks/paypal
 * with event types BILLING.SUBSCRIPTION.CANCELLED / BILLING.SUBSCRIPTION.PAYMENT.FAILED.
 */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const result = await handlePayPalWebhook(getStore(), getGateway(), getConfig(), {
    headers,
    rawBody,
    source: "paypal",
  }, getLlm());
  return Response.json(result.body, { status: result.status });
}
