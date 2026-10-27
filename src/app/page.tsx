import Link from "next/link";
import { getConfig, getGateway, getLlm, getStore } from "@/lib/runtime";
import { SimulateButton } from "@/components/SimulateButton";

export const dynamic = "force-dynamic";

function money(v: number, currency = "USD"): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${v.toFixed(2)}`;
}

const statusColor: Record<string, string> = {
  received: "bg-slate-700 text-slate-200",
  processing: "bg-amber-500/20 text-amber-300",
  offer_created: "bg-blue-500/20 text-blue-300",
  no_offer: "bg-slate-700 text-slate-300",
  ignored: "bg-slate-700 text-slate-400",
  error: "bg-red-500/20 text-red-300",
  pending: "bg-amber-500/20 text-amber-300",
  accepted: "bg-emerald-500/20 text-emerald-300",
  saved: "bg-emerald-500/20 text-emerald-300",
  active: "bg-emerald-500/20 text-emerald-300",
  cancelled: "bg-red-500/20 text-red-300",
  payment_failed: "bg-amber-500/20 text-amber-300",
};

export default function DashboardPage() {
  const store = getStore();
  const stats = store.stats();
  const events = store.listEvents(12);
  const offers = store.listOffers(12);
  const subscriptions = store.listSubscriptions();
  const mode = getConfig().mockMode ? "MOCK (no PayPal credentials)" : `LIVE ${getConfig().env}`;
  const llm = getLlm();
  const aiLabel = !llm.enabled
    ? "off (pure rules)"
    : llm.name === "nebius"
      ? `Nebius · ${llm.model}`
      : "mock (offline)";

  return (
    <div className="space-y-8">
      {/* Impact stats */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Recovery impact</h2>
          <div className="flex items-center gap-2">
            <span className="badge bg-blue-500/20 text-blue-300">AI decision layer: {aiLabel}</span>
            <span className="badge bg-slate-800 text-slate-400">gateway: {mode}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="card">
            <div className="stat-value text-emerald-400">{money(stats.recoveredMrr)}</div>
            <div className="stat-label">Recovered MRR</div>
          </div>
          <div className="card">
            <div className="stat-value">{stats.recoveries}</div>
            <div className="stat-label">Subscriptions saved</div>
          </div>
          <div className="card">
            <div className="stat-value">
              {stats.offersAccepted}
              <span className="text-lg text-slate-500">/{stats.offersCreated}</span>
            </div>
            <div className="stat-label">Offers accepted</div>
          </div>
          <div className="card">
            <div className="stat-value">{stats.totalEvents}</div>
            <div className="stat-label">Churn events processed</div>
          </div>
        </div>
      </section>

      {/* Funnel */}
      <section className="card">
        <h2 className="mb-4 text-lg font-semibold text-white">Recovery funnel</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {[
            ["Churn events", stats.totalEvents],
            ["Offers generated", stats.offersCreated],
            ["Offers accepted", stats.offersAccepted],
            ["Payments recovered", stats.recoveries],
          ].map(([label, n], i) => (
            <div key={label as string} className="flex items-center gap-3">
              {i > 0 && <span className="text-slate-600">→</span>}
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-center">
                <div className="text-xl font-bold text-white">{n as number}</div>
                <div className="text-xs text-slate-400">{label as string}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Subscriptions + demo triggers */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">Subscriptions</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3">Buyer</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Price / mo</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Simulate churn (demo)</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id} className="border-b border-slate-800/50 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{s.buyer_name}</div>
                    <div className="text-xs text-slate-500">{s.paypal_subscription_id}</div>
                  </td>
                  <td className="px-4 py-3">{s.plan}</td>
                  <td className="px-4 py-3">{money(s.monthly_price, s.currency)}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${statusColor[s.status] ?? ""}`}>{s.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <SimulateButton
                        paypalSubscriptionId={s.paypal_subscription_id}
                        eventType="BILLING.SUBSCRIPTION.CANCELLED"
                        label="Cancel"
                      />
                      <SimulateButton
                        paypalSubscriptionId={s.paypal_subscription_id}
                        eventType="BILLING.SUBSCRIPTION.PAYMENT.FAILED"
                        label="Payment failed"
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {subscriptions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No data — run <code className="text-slate-300">npm run seed</code> first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Event stream */}
        <section>
          <h2 className="mb-3 text-lg font-semibold text-white">Event stream</h2>
          <div className="space-y-3">
            {events.map((e) => {
              const trace: string[] = e.agent_trace ? JSON.parse(e.agent_trace) : [];
              return (
                <div key={e.id} className="card text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-slate-400">{e.type}</span>
                    <span className={`badge ${statusColor[e.status] ?? ""}`}>{e.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {new Date(e.created_at).toLocaleString()}
                  </div>
                  {trace.length > 0 && (
                    <div className="mt-2 font-mono text-xs text-slate-400">
                      {trace.join(" → ")}
                    </div>
                  )}
                </div>
              );
            })}
            {events.length === 0 && (
              <div className="card text-sm text-slate-500">
                No events yet. Hit a "Simulate churn" button above.
              </div>
            )}
          </div>
        </section>

        {/* Offers */}
        <section>
          <h2 className="mb-3 text-lg font-semibold text-white">Offers</h2>
          <div className="space-y-3">
            {offers.map((o) => {
              const aiTag =
                o.ai_provider === "nebius"
                  ? "AI: Nebius"
                  : o.ai_provider === "mock"
                    ? "AI: mock"
                    : "AI: rules";
              return (
                <div key={o.id} className="card text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-white">{o.title}</div>
                      <div className="text-xs text-slate-500">
                        {o.kind} · {o.discount_percent}% off · {o.currency} {o.offer_price.toFixed(2)}
                      </div>
                    </div>
                    <span className={`badge ${statusColor[o.status] ?? ""}`}>{o.status}</span>
                  </div>
                  {o.ai_reasoning && (
                    <div className="mt-2 rounded-lg border border-blue-900/50 bg-blue-950/20 p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="badge bg-blue-500/20 text-blue-300">{aiTag}</span>
                        {o.ai_confidence != null && (
                          <span className="text-xs text-slate-500">
                            confidence {(o.ai_confidence * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      <p className="text-xs leading-relaxed text-slate-300">{o.ai_reasoning}</p>
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <Link href={`/offers/${o.token}`} className="text-xs text-blue-400 hover:underline">
                      Open buyer page →
                    </Link>
                    <span className="text-xs text-slate-500">
                      retains {money(o.kind === "downgrade" ? (o.new_price ?? 0) : o.offer_price, o.currency)}/mo
                    </span>
                  </div>
                </div>
              );
            })}
            {offers.length === 0 && (
              <div className="card text-sm text-slate-500">No offers yet.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
