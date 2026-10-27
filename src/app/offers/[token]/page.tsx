import { notFound } from "next/navigation";
import { getStore } from "@/lib/runtime";
import { AcceptButton } from "@/components/AcceptButton";

export const dynamic = "force-dynamic";

/**
 * Buyer-facing page (also the target of the recovery email link):
 * shows the personalized retention offer and a one-click accept button that
 * creates + captures the discounted PayPal order.
 */
export default async function OfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const store = getStore();
  const offer = store.getOfferByToken(token);
  if (!offer) notFound();
  const subscription = store.getSubscriptionById(offer.subscription_id);
  const accepted = offer.status === "accepted";
  const aiProviderLabel =
    offer.ai_provider === "nebius"
      ? `Nebius · ${offer.ai_model ?? "LLM"}`
      : offer.ai_provider === "mock"
        ? "AI (offline mock)"
        : "Rule engine";

  return (
    <div className="mx-auto max-w-md space-y-6 py-6">
      <div className="text-center">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-400">
          {subscription?.plan ?? "Subscription"} retention offer
        </div>
        <h1 className="mt-2 text-2xl font-bold text-white">{offer.title}</h1>
      </div>

      <div className="card space-y-5">
        <p className="text-sm leading-relaxed text-slate-300">{offer.message}</p>

        {offer.ai_reasoning && (
          <div className="rounded-lg border border-blue-900/60 bg-blue-950/30 p-4">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="badge bg-blue-500/20 text-blue-300">AI insight</span>
              <span className="text-xs text-slate-500">{aiProviderLabel}</span>
              {offer.ai_confidence != null && (
                <span className="ml-auto text-xs text-slate-500">
                  confidence {(offer.ai_confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <p className="text-sm leading-relaxed text-slate-300">{offer.ai_reasoning}</p>
          </div>
        )}

        <div className="flex items-center justify-center gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <div className="text-center">
            <div className="text-sm text-slate-500 line-through">
              {offer.currency === "USD" ? "$" : `${offer.currency} `}
              {offer.original_price.toFixed(2)}
            </div>
            <div className="text-xs text-slate-600">was</div>
          </div>
          <div className="text-2xl text-emerald-400">→</div>
          <div className="text-center">
            <div className="text-2xl font-bold text-emerald-400">
              {offer.currency === "USD" ? "$" : `${offer.currency} `}
              {offer.offer_price.toFixed(2)}
            </div>
            <div className="text-xs text-slate-500">
              {offer.kind === "downgrade" ? `Starter plan / mo` : `for ${offer.discount_months} month${offer.discount_months > 1 ? "s" : ""}`}
            </div>
          </div>
        </div>

        <AcceptButton token={offer.token} />

        <p className="text-center text-xs text-slate-500">
          Offer expires {new Date(offer.expires_at).toLocaleDateString()} · secured by PayPal
        </p>
      </div>

      <p className="text-center text-xs text-slate-600">
        Powered by ChurnSave — your merchant picked this offer for you based on your history.
      </p>
    </div>
  );
}
