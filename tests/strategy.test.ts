import { describe, expect, it } from "vitest";
import {
  computeBuyerStats,
  decideOffer,
  recoveredMonthlyMrr,
  segmentBuyer,
} from "../src/lib/agent/strategy";
import type { PayPalTransaction } from "../src/lib/paypal/types";

function tx(value: number, monthsAgo = 0): PayPalTransaction {
  return {
    transaction_id: `TXN-${Math.random()}`,
    transaction_status: "S",
    transaction_amount: { currency_code: "USD", value: value.toFixed(2) },
    transaction_initiation_date: new Date(
      Date.now() - monthsAgo * 30 * 24 * 3600 * 1000,
    ).toISOString(),
  };
}

describe("computeBuyerStats", () => {
  it("sums payments into LTV and tenure", () => {
    const stats = computeBuyerStats([tx(49, 12), tx(49, 8), tx(49, 4), tx(49, 0)]);
    expect(stats).not.toBeNull();
    expect(stats!.ltv).toBe(196);
    expect(stats!.paymentCount).toBe(4);
    expect(stats!.tenureMonths).toBe(12);
    expect(stats!.monthlyAvg).toBeCloseTo(16.33, 1);
  });

  it("returns null with no history", () => {
    expect(computeBuyerStats([])).toBeNull();
  });
});

describe("segmentBuyer", () => {
  it("classifies by LTV bands", () => {
    expect(segmentBuyer(null)).toBe("unknown");
    expect(segmentBuyer({ ltv: 49, currency: "USD", paymentCount: 1, tenureMonths: 1, monthlyAvg: 49 })).toBe("light");
    expect(segmentBuyer({ ltv: 116, currency: "USD", paymentCount: 4, tenureMonths: 4, monthlyAvg: 29 })).toBe("steady");
    expect(segmentBuyer({ ltv: 588, currency: "USD", paymentCount: 12, tenureMonths: 12, monthlyAvg: 49 })).toBe("champion");
    // payment count alone can promote a buyer to champion
    expect(segmentBuyer({ ltv: 120, currency: "USD", paymentCount: 7, tenureMonths: 7, monthlyAvg: 17 })).toBe("champion");
  });
});

describe("decideOffer", () => {
  const cancelled = "BILLING.SUBSCRIPTION.CANCELLED" as const;
  const failed = "BILLING.SUBSCRIPTION.PAYMENT.FAILED" as const;

  it("champion cancellation -> 20% x 3 months", () => {
    const d = decideOffer({ segment: "champion", eventType: cancelled, monthlyPrice: 49, currency: "USD" });
    expect(d!.kind).toBe("discount");
    expect(d!.discountPercent).toBe(20);
    expect(d!.discountMonths).toBe(3);
    expect(d!.offerPrice).toBe(39.2);
    expect(recoveredMonthlyMrr(d!)).toBe(39.2);
  });

  it("steady cancellation -> 50% off one month", () => {
    const d = decideOffer({ segment: "steady", eventType: cancelled, monthlyPrice: 29, currency: "USD" });
    expect(d!.discountPercent).toBe(50);
    expect(d!.discountMonths).toBe(1);
    expect(d!.offerPrice).toBe(14.5);
  });

  it("light cancellation -> downgrade keeps 55% of MRR", () => {
    const d = decideOffer({ segment: "light", eventType: cancelled, monthlyPrice: 49, currency: "USD" });
    expect(d!.kind).toBe("downgrade");
    expect(d!.newPlan).toBe("Starter");
    expect(d!.newPrice).toBe(26.95);
    expect(recoveredMonthlyMrr(d!)).toBe(26.95);
  });

  it("unknown buyer -> soft 10% nudge", () => {
    const d = decideOffer({ segment: "unknown", eventType: cancelled, monthlyPrice: 19, currency: "USD" });
    expect(d!.discountPercent).toBe(10);
    expect(d!.offerPrice).toBe(17.1);
  });

  it("payment failure -> payment rescue with smaller discount", () => {
    const champion = decideOffer({ segment: "champion", eventType: failed, monthlyPrice: 49, currency: "USD" });
    expect(champion!.discountPercent).toBe(15);
    expect(champion!.offerPrice).toBe(41.65);
    const light = decideOffer({ segment: "light", eventType: failed, monthlyPrice: 49, currency: "USD" });
    expect(light!.discountPercent).toBe(10);
  });
});
