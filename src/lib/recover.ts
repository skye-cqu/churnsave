/**
 * The money moment: buyer clicks "Accept offer" -> agent creates a discounted
 * one-off order via the PayPal Orders API, captures it, and records a recovery
 * (recovered MRR) on the dashboard.
 */
import type { ChurnStore, OfferRow } from "../db/store";
import type { PayPalGateway } from "./paypal/types";
import { round2 } from "./agent/strategy";

export interface AcceptResult {
  offer: OfferRow;
  orderId: string;
  orderStatus: string;
  recoveryId: string;
  amount: number;
  monthlyMrr: number;
  currency: string;
}

export class AcceptError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
  }
}

export async function acceptOffer(
  store: ChurnStore,
  gateway: PayPalGateway,
  token: string,
): Promise<AcceptResult> {
  const offer = store.getOfferByToken(token);
  if (!offer) throw new AcceptError("offer not found", 404);
  if (offer.status === "accepted") throw new AcceptError("offer already accepted", 409);
  if (offer.status !== "pending") throw new AcceptError(`offer is ${offer.status}`, 409);
  if (new Date(offer.expires_at).getTime() < Date.now()) {
    store.setOfferStatus(offer.id, "expired");
    throw new AcceptError("offer expired", 410);
  }

  const subscription = store.getSubscriptionById(offer.subscription_id);
  if (!subscription) throw new AcceptError("subscription missing", 500);

  const description =
    offer.kind === "downgrade"
      ? `ChurnSave: switch to ${offer.new_plan} plan`
      : `ChurnSave: ${offer.title}`;

  // 1. create discounted order  2. capture payment  3. record recovery.
  const order = await gateway.createOrder({
    amount: offer.offer_price.toFixed(2),
    currency: offer.currency,
    description,
    customId: `offer:${offer.token}`,
  });
  const captured = await gateway.captureOrder(order.id);

  store.setOfferStatus(offer.id, "accepted");
  store.setSubscriptionStatus(subscription.id, "saved");
  if (offer.kind === "downgrade" && offer.new_plan && offer.new_price != null) {
    store.setSubscriptionPlan(subscription.id, offer.new_plan, offer.new_price);
  }

  const monthlyMrr =
    offer.kind === "downgrade" ? round2(offer.new_price ?? 0) : round2(offer.offer_price);
  const recovery = store.createRecovery({
    offer_id: offer.id,
    subscription_id: subscription.id,
    paypal_order_id: captured.id,
    amount: round2(offer.offer_price),
    monthly_mrr: monthlyMrr,
    currency: offer.currency,
  });

  return {
    offer,
    orderId: captured.id,
    orderStatus: captured.status,
    recoveryId: recovery.id,
    amount: recovery.amount,
    monthlyMrr: recovery.monthly_mrr,
    currency: recovery.currency,
  };
}
