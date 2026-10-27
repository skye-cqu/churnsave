import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface Merchant {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export type SubscriptionStatus = "active" | "cancelled" | "payment_failed" | "saved" | "churned";

export interface Subscription {
  id: string;
  merchant_id: string;
  paypal_subscription_id: string;
  buyer_name: string;
  buyer_email: string;
  plan: string;
  monthly_price: number;
  currency: string;
  status: SubscriptionStatus;
  started_at: string;
}

export interface TransactionRow {
  id: string;
  subscription_id: string;
  amount: number;
  currency: string;
  paid_at: string;
}

export type EventStatus = "received" | "processing" | "offer_created" | "no_offer" | "ignored" | "error";

export interface EventRow {
  id: string;
  subscription_id: string | null;
  type: string;
  payload: string;
  status: EventStatus;
  agent_trace: string | null;
  error: string | null;
  created_at: string;
}

export type OfferStatus = "pending" | "accepted" | "declined" | "expired";

export interface OfferRow {
  id: string;
  event_id: string;
  subscription_id: string;
  token: string;
  kind: "discount" | "downgrade";
  title: string;
  message: string;
  discount_percent: number;
  discount_months: number;
  new_plan: string | null;
  new_price: number | null;
  original_price: number;
  offer_price: number;
  currency: string;
  expires_at: string;
  status: OfferStatus;
  created_at: string;
  /** LLM layer: one-sentence personalized rationale (falls back to rule copy). */
  ai_reasoning: string | null;
  /** "nebius" | "mock" | "rules" (rules = LLM produced nothing, rule text used). */
  ai_provider: string | null;
  /** Model identifier, e.g. nvidia/llama-3.1-nemotron-70b-instruct. */
  ai_model: string | null;
  /** 0..1, null when rule fallback. */
  ai_confidence: number | null;
  /** Natural-language buyer portrait from transaction history. */
  ai_profile: string | null;
}

export interface RecoveryRow {
  id: string;
  offer_id: string;
  subscription_id: string;
  paypal_order_id: string;
  amount: number;
  monthly_mrr: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface FunnelStats {
  totalEvents: number;
  offersCreated: number;
  offersAccepted: number;
  recoveries: number;
  recoveredMrr: number;
  recoveredAmount: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  paypal_subscription_id TEXT NOT NULL UNIQUE,
  buyer_name TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  plan TEXT NOT NULL,
  monthly_price REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  paid_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_sub ON transactions(subscription_id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_trace TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  discount_percent REAL NOT NULL,
  discount_months INTEGER NOT NULL,
  new_plan TEXT,
  new_price REAL,
  original_price REAL NOT NULL,
  offer_price REAL NOT NULL,
  currency TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recoveries (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offers(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  paypal_order_id TEXT NOT NULL,
  amount REAL NOT NULL,
  monthly_mrr REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ai_reasoning TEXT,
  ai_provider TEXT,
  ai_model TEXT,
  ai_confidence REAL,
  ai_profile TEXT
);
`;

/**
 * Add the LLM AI columns to offers tables created before the decision layer
 * existed (fresh databases get them from SCHEMA directly). Cheap and idempotent.
 */
function migrateOffersAi(db: Database.Database): void {
  const cols = new Set(
    (db.pragma("table_info(offers)") as Array<{ name: string }>).map((c) => c.name),
  );
  const wanted: Array<[string, string]> = [
    ["ai_reasoning", "TEXT"],
    ["ai_provider", "TEXT"],
    ["ai_model", "TEXT"],
    ["ai_confidence", "REAL"],
    ["ai_profile", "TEXT"],
  ];
  for (const [name, type] of wanted) {
    if (!cols.has(name)) db.exec(`ALTER TABLE offers ADD COLUMN ${name} ${type}`);
  }
}

/** Typed data-access wrapper around better-sqlite3. One instance per app/test. */
export class ChurnStore {
  constructor(readonly db: Database.Database) {
    db.exec(SCHEMA);
    migrateOffersAi(db);
  }

  static inMemory(): ChurnStore {
    return new ChurnStore(new Database(":memory:"));
  }

  static fromFile(filename: string): ChurnStore {
    const db = new Database(filename);
    db.pragma("journal_mode = WAL");
    return new ChurnStore(db);
  }

  close(): void {
    this.db.close();
  }

  // -- merchants / subscriptions / history --------------------------------

  upsertMerchant(m: Pick<Merchant, "id" | "name" | "email">): void {
    this.db
      .prepare(
        `INSERT INTO merchants (id, name, email, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email`,
      )
      .run(m.id, m.name, m.email, new Date().toISOString());
  }

  upsertSubscription(s: Omit<Subscription, "id"> & { id?: string }): Subscription {
    const id = s.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO subscriptions (id, merchant_id, paypal_subscription_id, buyer_name, buyer_email,
            plan, monthly_price, currency, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paypal_subscription_id) DO UPDATE SET
            buyer_name = excluded.buyer_name, plan = excluded.plan,
            monthly_price = excluded.monthly_price, status = excluded.status`,
      )
      .run(
        id,
        s.merchant_id,
        s.paypal_subscription_id,
        s.buyer_name,
        s.buyer_email,
        s.plan,
        s.monthly_price,
        s.currency,
        s.status,
        s.started_at,
      );
    return this.getSubscriptionById(id)!;
  }

  addTransaction(t: Omit<TransactionRow, "id"> & { id?: string }): void {
    this.db
      .prepare(
        `INSERT INTO transactions (id, subscription_id, amount, currency, paid_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(t.id ?? randomUUID(), t.subscription_id, t.amount, t.currency, t.paid_at);
  }

  getSubscriptionById(id: string): Subscription | undefined {
    return this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as
      | Subscription
      | undefined;
  }

  getSubscriptionByPaypalId(paypalId: string): Subscription | undefined {
    return this.db
      .prepare("SELECT * FROM subscriptions WHERE paypal_subscription_id = ?")
      .get(paypalId) as Subscription | undefined;
  }

  listSubscriptions(): Subscription[] {
    return this.db
      .prepare("SELECT * FROM subscriptions ORDER BY started_at DESC")
      .all() as Subscription[];
  }

  getTransactions(subscriptionId: string): TransactionRow[] {
    return this.db
      .prepare("SELECT * FROM transactions WHERE subscription_id = ? ORDER BY paid_at ASC")
      .all(subscriptionId) as TransactionRow[];
  }

  setSubscriptionStatus(id: string, status: SubscriptionStatus): void {
    this.db.prepare("UPDATE subscriptions SET status = ? WHERE id = ?").run(status, id);
  }

  setSubscriptionPlan(id: string, plan: string, monthlyPrice: number): void {
    this.db
      .prepare("UPDATE subscriptions SET plan = ?, monthly_price = ? WHERE id = ?")
      .run(plan, monthlyPrice, id);
  }

  // -- events ---------------------------------------------------------------

  createEvent(input: {
    subscription_id: string | null;
    type: string;
    payload: string;
    status?: EventStatus;
  }): EventRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO events (id, subscription_id, type, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subscription_id,
        input.type,
        input.payload,
        input.status ?? "received",
        new Date().toISOString(),
      );
    return this.getEvent(id)!;
  }

  getEvent(id: string): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
  }

  setEventStatus(
    id: string,
    status: EventStatus,
    extra?: { agentTrace?: string[]; error?: string },
  ): void {
    this.db
      .prepare("UPDATE events SET status = ?, agent_trace = ?, error = ? WHERE id = ?")
      .run(
        status,
        extra?.agentTrace ? JSON.stringify(extra.agentTrace) : null,
        extra?.error ?? null,
        id,
      );
  }

  listEvents(limit = 25): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as EventRow[];
  }

  // -- offers ---------------------------------------------------------------

  createOffer(
    o: Omit<
      OfferRow,
      | "id"
      | "created_at"
      | "status"
      | "ai_reasoning"
      | "ai_provider"
      | "ai_model"
      | "ai_confidence"
      | "ai_profile"
    > &
      Partial<Pick<OfferRow, "ai_reasoning" | "ai_provider" | "ai_model" | "ai_confidence" | "ai_profile">> & {
        id?: string;
        status?: OfferStatus;
      },
  ): OfferRow {
    const id = o.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO offers (id, event_id, subscription_id, token, kind, title, message,
            discount_percent, discount_months, new_plan, new_price, original_price, offer_price,
            currency, expires_at, status, created_at,
            ai_reasoning, ai_provider, ai_model, ai_confidence, ai_profile)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.event_id,
        o.subscription_id,
        o.token,
        o.kind,
        o.title,
        o.message,
        o.discount_percent,
        o.discount_months,
        o.new_plan ?? null,
        o.new_price ?? null,
        o.original_price,
        o.offer_price,
        o.currency,
        o.expires_at,
        o.status ?? "pending",
        new Date().toISOString(),
        // LLM fields default to the deterministic rule copy until (unless) the
        // reasoning step overwrites them — the loop never waits on the LLM.
        o.ai_reasoning ?? o.message,
        o.ai_provider ?? "rules",
        o.ai_model ?? null,
        o.ai_confidence ?? null,
        o.ai_profile ?? null,
      );
    return this.getOfferByToken(o.token)!;
  }

  /** Persist the LLM reasoning step's output (or its rule fallback) on an offer. */
  setOfferAi(
    id: string,
    ai: {
      reasoning: string;
      provider: string;
      model?: string | null;
      confidence?: number | null;
      profile?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE offers SET ai_reasoning = ?, ai_provider = ?, ai_model = ?,
            ai_confidence = ?, ai_profile = COALESCE(?, ai_profile) WHERE id = ?`,
      )
      .run(
        ai.reasoning,
        ai.provider,
        ai.model ?? null,
        ai.confidence ?? null,
        ai.profile ?? null,
        id,
      );
  }

  getOfferByToken(token: string): OfferRow | undefined {
    return this.db.prepare("SELECT * FROM offers WHERE token = ?").get(token) as
      | OfferRow
      | undefined;
  }

  setOfferStatus(id: string, status: OfferStatus): void {
    this.db.prepare("UPDATE offers SET status = ? WHERE id = ?").run(status, id);
  }

  listOffers(limit = 25): OfferRow[] {
    return this.db
      .prepare("SELECT * FROM offers ORDER BY created_at DESC LIMIT ?")
      .all(limit) as OfferRow[];
  }

  // -- recoveries & stats ---------------------------------------------------

  createRecovery(r: Omit<RecoveryRow, "id" | "created_at" | "status">): RecoveryRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO recoveries (id, offer_id, subscription_id, paypal_order_id, amount,
            monthly_mrr, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.offer_id,
        r.subscription_id,
        r.paypal_order_id,
        r.amount,
        r.monthly_mrr,
        r.currency,
        "captured",
        new Date().toISOString(),
      );
    return this.db.prepare("SELECT * FROM recoveries WHERE id = ?").get(id) as RecoveryRow;
  }

  stats(): FunnelStats {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get() as { v: number }).v ?? 0;
    return {
      totalEvents: one("SELECT COUNT(*) AS v FROM events"),
      offersCreated: one("SELECT COUNT(*) AS v FROM offers"),
      offersAccepted: one("SELECT COUNT(*) AS v FROM offers WHERE status = 'accepted'"),
      recoveries: one("SELECT COUNT(*) AS v FROM recoveries"),
      recoveredMrr: one("SELECT COALESCE(SUM(monthly_mrr), 0) AS v FROM recoveries"),
      recoveredAmount: one("SELECT COALESCE(SUM(amount), 0) AS v FROM recoveries"),
    };
  }
}
