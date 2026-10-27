# ChurnSave Architecture

## 1. Bird's-eye data flow

```
┌──────────────┐   BILLING.SUBSCRIPTION.*    ┌───────────────────────────────┐
│   PayPal     │─────────webhook────────────▶│ POST /api/webhooks/paypal     │
│  (sandbox)   │                             │  - parse event                │
└──────────────┘                             │  - verify signature (live)    │
                                             │  - persist events row         │
┌──────────────┐   simulate button (demo)    └──────────────┬────────────────┘
│  Dashboard   │────────────────────────────────────────────┘
└──────┬───────┘                                              │
       │                                                      ▼
       │                                     ┌────────────────────────────────┐
       │                                     │ ChurnSave agent (graph run)    │
       │                                     │  findSubscription              │
       │                                     │    → fetchBuyerHistory         │
       │                                     │    → segmentBuyer              │
       │                                     │    → decideOffer               │
       │                                     └───────┬───────────────┬────────┘
       │                                             │               │
       │             PayPalGateway.searchTransactions│               │ offers.insert
       │                 (Transaction Search, live)  │               │
       │                                     ┌───────▼───────┐   ┌───▼────────────┐
       │                                     │  SQLite DB    │   │ offer page     │
       │                                     │ subscriptions │   │ /offers/token  │
       │                                     │ transactions  │   └───┬────────────┘
       │                                     │ events        │       │ buyer clicks Accept
       │                                     │ offers        │       ▼
       │                                     │ recoveries    │   POST /api/offers/
       │                                     └───────▲───────┘   └────/token/accept
       │                                             │               │
       │                                     recovery insert         │ createOrder + capture
       │                                             │       ┌───────▼─────────┐
       └◀── stats: Recovered MRR, funnel ────────────┴───────│ PayPal Orders   │
                                                             │ API v2 (mock/   │
                                                             │ live gateway)   │
                                                             └─────────────────┘
```

## 2. Components

| Module | File(s) | Responsibility |
| --- | --- | --- |
| Config | `src/lib/config.ts` | Reads `PAYPAL_*` env; decides mock vs live; sandbox/live API base |
| Gateway seam | `src/lib/paypal/types.ts` | `PayPalGateway` interface: transaction search, orders, webhook verify |
| Mock gateway | `src/lib/paypal/mock.ts` | In-memory orders + seeded history; identical interface |
| Live gateway | `src/lib/paypal/live.ts` | OAuth2 token cache; REST calls; injectable `fetch` for tests |
| Toolkit bridge | `src/lib/paypal/agent-toolkit.ts` | Lazily instantiates official `@paypal/agent-toolkit` (LangChain export) in live mode |
| Strategy (pure) | `src/lib/agent/strategy.ts` | `computeBuyerStats`, `segmentBuyer`, `decideOffer` — deterministic, unit-tested |
| Graph runner | `src/lib/agent/graph.ts` | ~40-line LangGraph-style runner: named nodes + edges + shared state + trace |
| Agent run | `src/lib/agent/run.ts` | Wires nodes together; persists offer; records trace on the event row |
| Webhook pipeline | `src/lib/webhook.ts` | Shared by real webhook route and demo simulator; verification + event persistence |
| Recovery | `src/lib/recover.ts` | Accept-offer flow: validate → create order → capture → mark saved → recovery row |
| Store | `src/db/store.ts` | better-sqlite3 wrapper with schema + typed queries |
| Seed | `src/db/seed-data.ts`, `scripts/seed.ts` | Demo merchant + 3 buyers (champion / steady / light) |
| UI | `src/app/page.tsx`, `src/app/offers/[token]/page.tsx` | Dashboard (merchant) and buyer acceptance page |

## 3. Database schema (SQLite)

```
merchants(id, name, email, created_at)
subscriptions(id, merchant_id→merchants, paypal_subscription_id UNIQUE,
              buyer_name, buyer_email, plan, monthly_price, currency,
              status: active|cancelled|payment_failed|saved|churned, started_at)
transactions(id, subscription_id→subscriptions, amount, currency, paid_at)
            -- local mirror of the buyer's PayPal payment history (LTV source)
events(id, subscription_id→subscriptions, type, payload, 
       status: received|processing|offer_created|no_offer|ignored|error,
       agent_trace JSON, error, created_at)
offers(id, event_id→events, subscription_id→subscriptions, token UNIQUE,
       kind: discount|downgrade, title, message, discount_percent, discount_months,
       new_plan, new_price, original_price, offer_price, currency,
       expires_at, status: pending|accepted|declined|expired, created_at)
recoveries(id, offer_id→offers, subscription_id→subscriptions,
           paypal_order_id, amount, monthly_mrr, currency, status, created_at)
```

`agent_trace` stores the graph node sequence per event (e.g.
`findSubscription → fetchBuyerHistory → segmentBuyer(ltv:588 → champion) → decideOffer(−20%)`),
shown in the dashboard event stream for transparency.

## 4. Agent decision logic

Segmentation (pure function of the buyer's transaction history):

- `champion`: LTV ≥ 300 **or** ≥ 6 payments
- `steady`: LTV ≥ 100
- `light`: anything below
- `unknown`: no history

Offer policy — deliberately interpretable and tunable in one file
(`src/lib/agent/strategy.ts`), so an LLM policy can replace `decideOffer` without
touching any PayPal plumbing. Rationale per rule:

- **Champion** → smallest profitable concession that keeps full engagement: 20% × 3 months.
- **Steady** → single-cycle 50% off: cheap experiment, resets at full price.
- **Light** → downgrade to Starter at 55%: partial MRR beats zero, matches usage.
- **Payment failure** → 10–15% "payment rescue": buyer didn't choose to leave;
  discount is compensation for the friction of updating the card.

## 5. Mock vs live — one seam, two gateways

Every PayPal touchpoint hangs off the `PayPalGateway` interface
(`src/lib/paypal/types.ts`). `createGateway(config)` returns:

- `MockPayPalGateway` — default (no credentials or `PAYPAL_MOCK=1`). Deterministic order
  ids (`MOCK-ORDER-0001`), `COMPLETED` captures, seeded history.
- `LivePayPalGateway` — real REST calls with an OAuth2 token cache. Takes an injectable
  `fetch` so tests stub the wire (see `tests/gateway.test.ts`).

Because both implement the same interface, the agent layer, webhook pipeline and recovery
flow are byte-identical in dev, test and production. The only behavioral difference:
in live mode the webhook route enforces real signature verification
(`POST /v1/notifications/verify-webhook-signature`); in mock/demo mode it trusts the
in-process caller (documented trade-off for a hackathon MVP — production would keep
verification always-on).

## 6. Agent-toolkit integration point

`src/lib/paypal/agent-toolkit.ts` lazily imports `@paypal/agent-toolkit/langchain`
(official package, Apache-2.0) and exposes `describeAgentToolkit(config)`:

- mock mode → static tool catalog (`list_transactions (mocked)`, ...), no credentials needed
- live mode → real `PayPalAgentToolkit` with `getTools()` — LangChain-ready PayPal tools

`GET /api/agent/tools` shows which tools are live. The deterministic MVP uses the REST
gateway directly; the toolkit bridge is the drop-in for 
an LLM negotiating agent (roadmap), sharing the same credentials and context.

## 7. Test map

| File | Covers |
| --- | --- |
| `tests/strategy.test.ts` | LTV math, segmentation bands, every offer rule + rounding |
| `tests/gateway.test.ts` | Mock order lifecycle; live adapter OAuth/search/order/capture/verify against stubbed fetch |
| `tests/flow.test.ts` | Full closed loop x4 scenarios: champion cancel, light downgrade, payment rescue, unknown-subscription/invalid-JSON/unhandled-type handling |

## 8. Known MVP limits

- Email delivery is stubbed by the offer URL itself (dashboard link); production wires a
  transactional email provider onto `offers.created`.
- The transactions table is seeded locally; in live mode `fetchBuyerHistory` mirrors
  Transaction Search results into it (subscription-scoped filtering by transaction note).
- Deterministic rules, not an LLM policy — intentional for auditability and cost;
  the strategy module is the replacement seam.
