# ChurnSave

**An autonomous churn-recovery agent for PayPal subscriptions.**

When a subscriber cancels — or a payment fails — PayPal fires a webhook. ChurnSave's agent
analyzes that buyer's transaction history, picks the right retention offer (discount or
downgrade), and hands the buyer a one-click acceptance page. The moment they accept, a
discounted PayPal order is created and captured, and the dashboard counts the **recovered MRR**.

Built for the **PayPal AI Hackathon**.

## Why

Subscription businesses lose 5–7% of MRR every month to churn, and most of it is silent:
the cancellation webhook arrives, nobody reacts, the revenue is gone. ChurnSave closes that
gap in seconds instead of never:

- **Cancel-happy power users** (high LTV) get a loyalty discount worth giving.
- **Marginal users** get a cheaper plan instead of churning completely — partial MRR beats zero.
- **Payment failures** (not the buyer's choice) get a small rescue nudge to update their card.

The agent decides *how much to give away* based on what the buyer is actually worth —
via PayPal's own Transaction Search API.

## How it works

```
PayPal webhook (cancel / payment failure)
        │
        ▼
POST /api/webhooks/paypal  ──►  signature verification (sandbox-aware)
        │
        ▼
ChurnSave agent (LangGraph-style state machine)
  1. findSubscription      – map webhook → subscription
  2. fetchBuyerHistory     – PayPal Transaction Search
  3. segmentBuyer          – LTV + tenure → champion / steady / light / unknown
  4. decideOffer           – rules → personalized offer
        │
        ▼
Offer page /offers/<token>   (email/dashboard link)
        │  buyer clicks "Accept"
        ▼
POST /api/offers/<token>/accept
  → PayPal Orders API: create discounted order → capture
  → recovery recorded → dashboard Recovered-MRR counter ticks up
```

**Decision matrix**

| Buyer segment      | Trigger            | Offer                        | MRR retained |
| ------------------ | ------------------ | ---------------------------- | ------------ |
| Champion (LTV≥300) | cancellation       | 20% off next 3 months        | 80%          |
| Steady (LTV≥100)   | cancellation       | 50% off next month           | 50%          |
| Light (LTV<100)    | cancellation       | downgrade to Starter (−45%)  | 55%          |
| Unknown            | cancellation       | 10% off one month            | 90%          |
| any                | payment failure    | 10–15% payment rescue        | 85–90%       |

## Quick start (no PayPal account needed)

```bash
npm install
npm run seed     # demo merchant + 3 buyers with different spending histories
npm run dev      # http://localhost:3000
```

On the dashboard, hit **Cancel** or **Payment failed** on any subscriber. The agent runs,
an offer appears; open the buyer page, click **Accept**, and watch Recovered MRR go up.

Everything runs against an in-process mock PayPal gateway by default — the full loop works
with zero credentials. To go live against PayPal sandbox:

```bash
cp .env.example .env   # fill in PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (+ WEBHOOK_ID)
npm run seed && npm run dev
```

## PayPal products used

| Capability                  | PayPal API                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| Churn signal                | Webhooks: `BILLING.SUBSCRIPTION.CANCELLED`, `.PAYMENT.FAILED`     |
| Buyer history / LTV         | Transaction Search API (`/v1/reporting/transactions`)            |
| Discounted recovery payment | Orders API v2 (`/v2/checkout/orders` + capture)                  |
| Webhook authenticity        | `/v1/notifications/verify-webhook-signature`                     |
| Agent tool bridge           | [`@paypal/agent-toolkit`](https://www.npmjs.com/package/@paypal/agent-toolkit) (LangChain export, live mode) |

## Tests

```bash
npm test
```

20 tests, fully offline: decision matrix unit tests, live-REST adapter against a stubbed
`fetch`, and the complete closed loop (webhook → agent → offer → accept → recovery).

## Repo layout

```
src/db          SQLite schema + typed store + demo seed data
src/lib/paypal  Gateway interface, mock gateway, live REST adapter, agent-toolkit bridge
src/lib/agent   Strategy (pure), LangGraph-style graph runner, agent orchestration
src/lib         Webhook pipeline, accept/recovery flow, runtime config
src/app         Dashboard + buyer offer page + API routes
tests           Vitest: strategy, gateway, closed-loop flow
docs            Architecture deep-dive, 90-second demo script
```

MIT licensed. This is a hackathon MVP: the recovery engine and PayPal integrations are real
and tested; deployment, email delivery and LLM-based negotiation are roadmap items.
