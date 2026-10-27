/**
 * Gateway tests: mock behavior + live REST adapter verified against a
 * stubbed fetch (proves OAuth, Transaction Search, Orders and webhook
 * verification wiring without any real credentials).
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/lib/config";
import { LivePayPalGateway } from "../src/lib/paypal/live";
import { MockPayPalGateway } from "../src/lib/paypal/mock";

describe("MockPayPalGateway", () => {
  it("creates and captures orders", async () => {
    const gw = new MockPayPalGateway();
    const order = await gw.createOrder({
      amount: "39.20",
      currency: "USD",
      description: "test order",
    });
    expect(order.status).toBe("CREATED");
    const captured = await gw.captureOrder(order.id);
    expect(captured.status).toBe("COMPLETED");
  });

  it("rejects capture of unknown orders", async () => {
    const gw = new MockPayPalGateway();
    await expect(gw.captureOrder("MOCK-NOPE")).rejects.toThrow(/unknown order/);
  });

  it("serves seeded history and webhook verification result", async () => {
    const history = {
      "I-1": [
        {
          transaction_id: "TXN-1",
          transaction_status: "S",
          transaction_amount: { currency_code: "USD", value: "49.00" },
          transaction_initiation_date: new Date().toISOString(),
        },
      ],
    };
    const gw = new MockPayPalGateway(history, true);
    expect(await gw.searchTransactions({ subscriptionId: "I-1", startDate: "", endDate: "" })).toHaveLength(1);
    expect(await gw.searchTransactions({ subscriptionId: "I-X", startDate: "", endDate: "" })).toHaveLength(0);
    expect(await gw.verifyWebhook({}, "{}")).toBe(true);
  });
});

describe("LivePayPalGateway (stubbed fetch)", () => {
  function stubFetch(responses: Array<{ expectUrl: RegExp; body: unknown }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = vi.fn(async (url: any, init: any = {}) => {
      const spec = responses[i];
      const urlStr = String(url);
      calls.push({ url: urlStr, init });
      expect(urlStr).toMatch(spec.expectUrl);
      i += 1;
      return {
        ok: true,
        status: 200,
        json: async () => spec.body,
        text: async () => JSON.stringify(spec.body),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  const config = loadConfig({
    PAYPAL_CLIENT_ID: "test-id",
    PAYPAL_CLIENT_SECRET: "test-secret",
    PAYPAL_ENV: "sandbox",
    PAYPAL_MOCK: "0",
  });

  it("authenticates once and searches transactions", async () => {
    const { fetchImpl, calls } = stubFetch([
      { expectUrl: /\/v1\/oauth2\/token$/, body: { access_token: "AT-123", expires_in: 32400 } },
      {
        expectUrl: /\/v1\/reporting\/transactions/,
        body: {
          transaction_details: [
            {
              transaction_id: "TXN-A",
              transaction_status: "S",
              transaction_amount: { currency_code: "USD", value: "49.00" },
              transaction_initiation_date: "2026-10-01T00:00:00Z",
              transaction_note: "I-DEMO_CHAMPION_01 monthly payment",
            },
          ],
        },
      },
    ]);
    const gw = new LivePayPalGateway(config, fetchImpl);
    const txs = await gw.searchTransactions({
      subscriptionId: "I-DEMO_CHAMPION_01",
      startDate: "2025-10-27T00:00:00Z",
      endDate: "2026-10-27T00:00:00Z",
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].transaction_id).toBe("TXN-A");
    // first call is OAuth with basic auth, second uses bearer token
    expect(calls[0].init.headers).toMatchObject({
      Authorization: expect.stringContaining("Basic "),
    });
    expect(calls[1].init.headers).toMatchObject({ Authorization: "Bearer AT-123" });
  });

  it("creates and captures a discounted order", async () => {
    const { fetchImpl } = stubFetch([
      { expectUrl: /\/v1\/oauth2\/token$/, body: { access_token: "AT-1", expires_in: 32400 } },
      { expectUrl: /\/v2\/checkout\/orders$/, body: { id: "ORDER-1", status: "CREATED" } },
      { expectUrl: /\/v2\/checkout\/orders\/ORDER-1\/capture$/, body: { id: "ORDER-1", status: "COMPLETED" } },
    ]);
    const gw = new LivePayPalGateway(config, fetchImpl);
    const order = await gw.createOrder({
      amount: "39.20",
      currency: "USD",
      description: "ChurnSave: 20% off",
      customId: "offer:tok",
    });
    expect(order.id).toBe("ORDER-1");
    const captured = await gw.captureOrder(order.id);
    expect(captured.status).toBe("COMPLETED");
  });

  it("verifies webhook signatures via PayPal", async () => {
    const { fetchImpl } = stubFetch([
      { expectUrl: /\/v1\/oauth2\/token$/, body: { access_token: "AT-2", expires_in: 32400 } },
      {
        expectUrl: /\/v1\/notifications\/verify-webhook-signature$/,
        body: { verification_status: "SUCCESS" },
      },
    ]);
    const gw = new LivePayPalGateway({ ...config, webhookId: "WH-ID-1" }, fetchImpl);
    const ok = await gw.verifyWebhook(
      {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.paypal.com/cert",
        "paypal-transmission-id": "tid",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": "now",
      },
      '{"id":"WH-1"}',
    );
    expect(ok).toBe(true);
  });

  it("fails verification when PayPal says so", async () => {
    const { fetchImpl } = stubFetch([
      { expectUrl: /\/v1\/oauth2\/token$/, body: { access_token: "AT-3", expires_in: 32400 } },
      {
        expectUrl: /verify-webhook-signature$/,
        body: { verification_status: "FAILURE" },
      },
    ]);
    const gw = new LivePayPalGateway({ ...config, webhookId: "WH-ID-1" }, fetchImpl);
    expect(await gw.verifyWebhook({}, "{}")).toBe(false);
  });
});
