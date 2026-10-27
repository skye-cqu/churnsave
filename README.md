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
  4. summarizeBuyerHistory – LLM: transactions → buyer portrait (trace/UI)
  5. decideOffer           – rules → personalized offer (decision authority)
  6. decideOfferReasoning  – LLM: reviews the offer candidate → one-sentence
                             personalized rationale + confidence
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

## AI decision layer

The rule engine above decides **what** to offer; an LLM layer explains **why**
and personalizes the pitch. Two reasoning points run inside the agent loop:

1. **`summarizeBuyerHistory`** — the buyer's PayPal transactions become a
   natural-language portrait ("12 payments totaling $588.00 over ~12 months…
   high-LTV loyal customer"), stored on the offer and visible in the dashboard.
2. **`decideOfferReasoning`** — the LLM reviews the rule-engine's offer
   candidate and writes a one-sentence personalized rationale with a
   confidence score. Buyers see it on the offer page ("AI insight"), merchants
   see it on offer cards; the agent trace shows each LLM step.

Providers (pluggable, in `src/lib/agent/llm.ts`):

- **`NebiusProvider`** — OpenAI-compatible `/chat/completions` against
  [Nebius Token Factory](https://nebius.ai) with NVIDIA's open
  `nvidia/llama-3.1-nemotron-70b-instruct` by default. Output is
  JSON-schema-constrained (`{reasoning, confidence}`) and validated.
- **`MockProvider`** (default, zero config) — deterministic offline mirror of
  the rules, so tests and key-less runs stay fully green without network.

Reliability contract: every LLM call is bounded (3s timeout by default) and any
failure — no key, layer disabled, timeout, HTTP error, bad JSON — degrades to
the deterministic rule copy without blocking the retention loop. Set
`LLM_ENABLED=false` for pure-rules mode, or `NEBIUS_API_KEY=...` to go live.
One-step setup guide: [`docs/NEBIUS.md`](docs/NEBIUS.md).

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

20 offline tests: decision matrix unit tests, live-REST adapter against a
stubbed `fetch`, the LLM provider layer (mock determinism, Nebius request
construction/degradation/timeout against a stubbed fetch), and the complete
closed loop (webhook → agent → offer → accept → recovery) — with the LLM layer
in mock mode, in failure-fallback mode, and switched off entirely.

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

MIT licensed. This is a hackathon MVP: the recovery engine, PayPal integrations
and the LLM decision layer (Nebius/NVIDIA or offline mock) are real and tested;
deployment and email delivery are roadmap items.
