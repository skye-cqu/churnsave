/**
 * ChurnSave decision logic — pure, deterministic, unit-testable.
 *
 * The agent reads a buyer's PayPal transaction history, segments them by
 * lifetime value, and picks the cheapest offer that is likely to retain them:
 *
 *   champion (high LTV)      -> 20% off the next 3 months
 *   steady  (medium LTV)     -> 50% off the next month
 *   light   (low LTV)        -> downgrade to Starter instead of losing them
 *   unknown (no history)     -> 10% off one month (soft nudge)
 *
 * Payment failures get a smaller "payment rescue" discount (the buyer did not
 * choose to leave), plus a card-update prompt.
 */
import type { PayPalTransaction } from "../paypal/types";

export type ChurnEventType = "BILLING.SUBSCRIPTION.CANCELLED" | "BILLING.SUBSCRIPTION.PAYMENT.FAILED";

export interface BuyerStats {
  ltv: number;
  currency: string;
  paymentCount: number;
  tenureMonths: number;
  monthlyAvg: number;
}

export type Segment = "champion" | "steady" | "light" | "unknown";

export interface OfferDraft {
  kind: "discount" | "downgrade";
  title: string;
  message: string;
  discountPercent: number; // 0-100
  discountMonths: number;
  newPlan?: string;
  newPrice?: number;
  originalPrice: number;
  offerPrice: number;
}

export interface DecideInput {
  segment: Segment;
  eventType: ChurnEventType;
  monthlyPrice: number;
  currency: string;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate a buyer's paid transactions into retention-relevant stats. */
export function computeBuyerStats(txs: PayPalTransaction[]): BuyerStats | null {
  const paid = txs.filter(
    (t) =>
      t.transaction_status === "S" || t.transaction_status?.toUpperCase() === "SUCCESS" ||
      Number(t.transaction_amount?.value ?? 0) > 0,
  );
  if (paid.length === 0) return null;
  const values = paid.map((t) => Number(t.transaction_amount.value));
  const ltv = round2(values.reduce((a, b) => a + b, 0));
  const dates = paid
    .map((t) => new Date(t.transaction_initiation_date).getTime())
    .filter((n) => !Number.isNaN(n));
  const first = Math.min(...dates);
  const last = Math.max(...dates);
  const tenureMonths = Math.max(1, Math.ceil((last - first) / (1000 * 60 * 60 * 24 * 30)));
  return {
    ltv,
    currency: paid[0].transaction_amount.currency_code,
    paymentCount: paid.length,
    tenureMonths,
    monthlyAvg: round2(ltv / tenureMonths),
  };
}

/** Rule-based segmentation by lifetime value and tenure. */
export function segmentBuyer(stats: BuyerStats | null): Segment {
  if (!stats) return "unknown";
  if (stats.ltv >= 300 || stats.paymentCount >= 6) return "champion";
  if (stats.ltv >= 100) return "steady";
  return "light";
}

/** Monthly MRR retained if the offer is accepted. */
export function recoveredMonthlyMrr(draft: OfferDraft): number {
  return draft.kind === "downgrade" ? round2(draft.newPrice ?? 0) : draft.offerPrice;
}

/** The heart of the agent: buyer segment + churn signal -> personalized offer. */
export function decideOffer(input: DecideInput): OfferDraft | null {
  const { segment, eventType, monthlyPrice, currency } = input;
  const sym = currency === "USD" ? "$" : `${currency} `;

  if (eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
    // Buyer didn't choose to leave — smallest incentive that unblocks payment.
    const pct = segment === "champion" ? 15 : 10;
    const offerPrice = round2(monthlyPrice * (1 - pct / 100));
    return {
      kind: "discount",
      title: "Quick fix: update your payment method",
      message:
        `We couldn't process this month's ${sym}${monthlyPrice.toFixed(2)} payment. ` +
        `Update your card and your next cycle is ${pct}% off — just ${sym}${offerPrice.toFixed(2)}.`,
      discountPercent: pct,
      discountMonths: 1,
      originalPrice: monthlyPrice,
      offerPrice,
    };
  }

  switch (segment) {
    case "champion": {
      const offerPrice = round2(monthlyPrice * 0.8);
      return {
        kind: "discount",
        title: "We'd hate to see you go — 20% off for 3 months",
        message:
          `You've been with us for a while and it shows. Stay and we'll take 20% off ` +
          `for the next 3 months (${sym}${offerPrice.toFixed(2)}/mo instead of ${sym}${monthlyPrice.toFixed(2)}).`,
        discountPercent: 20,
        discountMonths: 3,
        originalPrice: monthlyPrice,
        offerPrice,
      };
    }
    case "steady": {
      const offerPrice = round2(monthlyPrice * 0.5);
      return {
        kind: "discount",
        title: "Half off your next month if you stay",
        message:
          `Thinking of leaving? Give us one more month — your next cycle is 50% off: ` +
          `${sym}${offerPrice.toFixed(2)} instead of ${sym}${monthlyPrice.toFixed(2)}.`,
        discountPercent: 50,
        discountMonths: 1,
        originalPrice: monthlyPrice,
        offerPrice,
      };
    }
    case "light": {
      // Downgrade beats churn: keep some MRR instead of zero.
      const newPrice = round2(monthlyPrice * 0.55);
      return {
        kind: "downgrade",
        title: "A lighter plan that fits",
        message:
          `If the ${sym}${monthlyPrice.toFixed(2)} plan is more than you need, ` +
          `switch to Starter at ${sym}${newPrice.toFixed(2)}/mo — same core features, less cost.`,
        discountPercent: 45,
        discountMonths: 1,
        newPlan: "Starter",
        newPrice,
        originalPrice: monthlyPrice,
        offerPrice: newPrice,
      };
    }
    case "unknown": {
      const offerPrice = round2(monthlyPrice * 0.9);
      return {
        kind: "discount",
        title: "One month, 10% off — stay with us",
        message: `Your next cycle is ${sym}${offerPrice.toFixed(2)} instead of ${sym}${monthlyPrice.toFixed(2)}. One click to keep your subscription.`,
        discountPercent: 10,
        discountMonths: 1,
        originalPrice: monthlyPrice,
        offerPrice,
      };
    }
    default:
      return null;
  }
}
