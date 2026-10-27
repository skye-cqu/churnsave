/**
 * Demo dataset used by `npm run seed` and by the integration tests:
 * three buyers with very different spending histories -> three different offers.
 */
import type { ChurnStore } from "./store";

export interface SeedBuyer {
  paypal_subscription_id: string;
  buyer_name: string;
  buyer_email: string;
  plan: string;
  monthly_price: number;
  currency: string;
  /** Number of historical monthly payments. */
  payments: number;
  /** Amount of each historical payment. */
  amount: number;
}

export const DEMO_MERCHANT = { id: "merch-demo-001", name: "Acme SaaS (demo)", email: "billing@acme.demo" };

export const DEMO_BUYERS: SeedBuyer[] = [
  {
    paypal_subscription_id: "I-DEMO_CHAMPION_01",
    buyer_name: "Ava Chen",
    buyer_email: "ava.chen@example.com",
    plan: "Pro",
    monthly_price: 49,
    currency: "USD",
    payments: 12,
    amount: 49, // LTV 588 -> champion -> 20% x 3 months
  },
  {
    paypal_subscription_id: "I-DEMO_STEADY_02",
    buyer_name: "Ben Ortiz",
    buyer_email: "ben.ortiz@example.com",
    plan: "Growth",
    monthly_price: 29,
    currency: "USD",
    payments: 4,
    amount: 29, // LTV 116 -> steady -> 50% off one month
  },
  {
    paypal_subscription_id: "I-DEMO_LIGHT_03",
    buyer_name: "Chloe Park",
    buyer_email: "chloe.park@example.com",
    plan: "Pro",
    monthly_price: 49,
    currency: "USD",
    payments: 1,
    amount: 49, // LTV 49 -> light -> downgrade to Starter
  },
];

/** Wipe tables and insert the demo merchant + buyers + history. */
export function seedDemoData(store: ChurnStore): void {
  store.db.exec("DELETE FROM recoveries; DELETE FROM offers; DELETE FROM events; DELETE FROM transactions; DELETE FROM subscriptions; DELETE FROM merchants;");
  store.upsertMerchant(DEMO_MERCHANT);

  for (const b of DEMO_BUYERS) {
    const started = new Date(Date.now() - b.payments * 30 * 24 * 60 * 60 * 1000);
    const sub = store.upsertSubscription({
      merchant_id: DEMO_MERCHANT.id,
      paypal_subscription_id: b.paypal_subscription_id,
      buyer_name: b.buyer_name,
      buyer_email: b.buyer_email,
      plan: b.plan,
      monthly_price: b.monthly_price,
      currency: b.currency,
      status: "active",
      started_at: started.toISOString(),
    });
    for (let i = 0; i < b.payments; i++) {
      store.addTransaction({
        subscription_id: sub.id,
        amount: b.amount,
        currency: b.currency,
        paid_at: new Date(started.getTime() + i * 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  }
}
