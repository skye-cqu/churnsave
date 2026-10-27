# ChurnSave — 90-second demo script

Recording setup: `npm run seed && npm run dev` on a fresh database
(http://localhost:3000, gateway badge reads **MOCK**). Screen recorder at 1080p.

## 0:00–0:15 — The problem

- **VO:** "Subscription businesses lose revenue the moment a buyer clicks cancel.
  PayPal tells you the subscription is gone — but nothing brings it back."
- **Screen:** any pricing page or the dashboard, empty funnel.
- Optional overlay stat: "5–7% of MRR churns monthly; most cancellations get no response."

## 0:15–0:60 — The closed loop

1. **(0:15)** Dashboard, Subscriptions table. Highlight **Ava Chen — Pro, $49/mo,
   status active**. **VO:** "Ava is a power user — twelve months of history on PayPal."
2. **(0:22)** Click **Cancel** on her row. Badge flips to **offer ready** almost instantly.
   **VO:** "PayPal fires the cancellation webhook. The ChurnSave agent takes over."
3. **(0:28)** Point at the **Event stream**: show the agent trace —
   `findSubscription → fetchBuyerHistory → ltv:588 → champion → decision:discount −20%`.
   **VO:** "It pulls her transaction history from PayPal, computes her lifetime value,
   and decides she's worth saving: 20% off for three months."
4. **(0:38)** Click **Open buyer page →**. The personalized offer card:
   ~~$49.00~~ → **$39.20**, blue **Accept** button. **VO:** "The buyer gets one link,
   one click — a real discounted PayPal order behind it."
5. **(0:46)** Click **Accept offer & keep my subscription**. Success message shows
   `Payment captured (order MOCK-ORDER-0001)`. **VO:** "She accepts. ChurnSave creates
   and captures the discounted order through the Orders API."

## 0:60–0:90 — Dashboard & impact

1. **(1:00)** Back on the dashboard. **Recovered MRR** card now shows **$39.20**;
   funnel shows 1 event → 1 offer → 1 accepted → 1 recovered; her status is **saved**.
   **VO:** "Back on the merchant dashboard: one recovered subscription, MRR that was
   gone is back on the books."
2. **(1:10)** Click **Cancel** on **Chloe Park** (one payment only), then open her offer:
   instead of a discount, it's a **downgrade to Starter at $26.95**. Click accept.
   **VO:** "A different buyer gets a different offer. Low lifetime value? Downgrade
   instead of lose them — fifty-five percent of the MRR beats zero."
3. **(1:20)** Final shot: two subscriptions saved, **Recovered MRR $66.15**, funnel 2→2→2→2.
   **VO:** "ChurnSave turns PayPal churn webhooks into recovered revenue — automatically.
   Every offer, payment and recovery runs on PayPal APIs."

## Fallback takes (if short on time)

- Show only the champion loop + dashboard (45s cut).
- If offers pile up from testing, re-run `npm run seed` for a clean slate.
