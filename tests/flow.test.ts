/**
 * Full closed-loop test with zero network: seed -> CANCELLED webhook ->
 * agent offer -> buyer accepts -> discounted PayPal order captured ->
 * recovery recorded -> dashboard stats update.
 */
import { describe, expect, it } from "vitest";
import { ChurnStore } from "../src/db/store";
import { seedDemoData } from "../src/db/seed-data";
import { loadConfig } from "../src/lib/config";
import { MockPayPalGateway } from "../src/lib/paypal/mock";
import { acceptOffer, AcceptError } from "../src/lib/recover";
import { handlePayPalWebhook } from "../src/lib/webhook";

function webhookBody(paypalSubscriptionId: string, eventType: string): string {
  return JSON.stringify({
    id: `WH-${Math.random()}`,
    event_type: eventType,
    resource: { id: paypalSubscriptionId },
  });
}

describe("churn recovery closed loop (mock gateway)", () => {
  it("cancellation of a champion -> 20% offer -> accept -> recovered MRR", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const gateway = new MockPayPalGateway();
    const config = loadConfig({}); // no credentials -> mock mode
    expect(config.mockMode).toBe(true);

    // 1. PayPal sends the cancellation webhook
    const res = await handlePayPalWebhook(store, gateway, config, {
      headers: {},
      rawBody: webhookBody("I-DEMO_CHAMPION_01", "BILLING.SUBSCRIPTION.CANCELLED"),
      source: "paypal",
    });
    expect(res.status).toBe(200);
    expect(res.body.agentStatus).toBe("offer_created");
    expect(res.body.segment).toBe("champion");
    const token = res.body.offerToken as string;
    expect(token).toBeTruthy();

    // 2. Agent generated the right personalized offer
    const offer = store.getOfferByToken(token)!;
    expect(offer.kind).toBe("discount");
    expect(offer.discount_percent).toBe(20);
    expect(offer.discount_months).toBe(3);
    expect(offer.offer_price).toBe(39.2);
    expect(offer.status).toBe("pending");

    // 3. Buyer accepts -> discounted order created + captured via Orders API
    const result = await acceptOffer(store, gateway, token);
    expect(result.orderId).toMatch(/^MOCK-ORDER-/);
    expect(result.orderStatus).toBe("COMPLETED");
    expect(result.amount).toBe(39.2);
    expect(result.monthlyMrr).toBe(39.2);

    // 4. Recovery recorded, subscription saved, dashboard stats update
    const stats = store.stats();
    expect(stats.offersAccepted).toBe(1);
    expect(stats.recoveries).toBe(1);
    expect(stats.recoveredMrr).toBeCloseTo(39.2);
    expect(store.getSubscriptionByPaypalId("I-DEMO_CHAMPION_01")!.status).toBe("saved");

    // 5. Offer cannot be accepted twice
    await expect(acceptOffer(store, gateway, token)).rejects.toMatchObject({
      httpStatus: 409,
    });
  });

  it("low-value cancellation -> downgrade offer -> plan switch, partial MRR retained", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const gateway = new MockPayPalGateway();
    const config = loadConfig({});

    const res = await handlePayPalWebhook(store, gateway, config, {
      headers: {},
      rawBody: webhookBody("I-DEMO_LIGHT_03", "BILLING.SUBSCRIPTION.CANCELLED"),
      source: "demo",
    });
    expect(res.body.segment).toBe("light");
    const offer = store.getOfferByToken(res.body.offerToken as string)!;
    expect(offer.kind).toBe("downgrade");

    const result = await acceptOffer(store, gateway, offer.token);
    expect(result.monthlyMrr).toBe(26.95); // 49 * 0.55

    const sub = store.getSubscriptionByPaypalId("I-DEMO_LIGHT_03")!;
    expect(sub.status).toBe("saved");
    expect(sub.plan).toBe("Starter");
    expect(sub.monthly_price).toBe(26.95);
    expect(store.stats().recoveredMrr).toBeCloseTo(26.95);
  });

  it("payment failure -> payment-rescue discount, subscription saved", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const gateway = new MockPayPalGateway();
    const config = loadConfig({});

    const res = await handlePayPalWebhook(store, gateway, config, {
      headers: {},
      rawBody: webhookBody("I-DEMO_STEADY_02", "BILLING.SUBSCRIPTION.PAYMENT.FAILED"),
      source: "demo",
    });
    expect(res.body.segment).toBe("steady");
    const offer = store.getOfferByToken(res.body.offerToken as string)!;
    expect(offer.discount_percent).toBe(10); // non-champion payment rescue

    await acceptOffer(store, gateway, offer.token);
    expect(store.getSubscriptionByPaypalId("I-DEMO_STEADY_02")!.status).toBe("saved");
  });

  it("unknown subscription is ignored, invalid JSON is rejected", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const gateway = new MockPayPalGateway();
    const config = loadConfig({});

    const ignored = await handlePayPalWebhook(store, gateway, config, {
      headers: {},
      rawBody: webhookBody("I-DOES-NOT-EXIST", "BILLING.SUBSCRIPTION.CANCELLED"),
    });
    expect(ignored.body.agentStatus).toBe("ignored");

    const bad = await handlePayPalWebhook(store, gateway, config, {
      headers: {},
      rawBody: "not json",
    });
    expect(bad.status).toBe(400);
  });

  it("unhandled event types pass through untouched", async () => {
    const store = ChurnStore.inMemory();
    seedDemoData(store);
    const res = await handlePayPalWebhook(store, new MockPayPalGateway(), loadConfig({}), {
      headers: {},
      rawBody: webhookBody("I-DEMO_CHAMPION_01", "PAYMENT.CAPTURE.COMPLETED"),
    });
    expect(res.body.ignored).toBe(true);
    expect(store.stats().totalEvents).toBe(0);
  });
});
