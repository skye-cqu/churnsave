/** Types mirroring the subset of the PayPal REST API used by ChurnSave. */

/** Transaction Search API (/v1/reporting/transactions) row. */
export interface PayPalTransaction {
  transaction_id: string;
  transaction_status: string;
  transaction_amount: { currency_code: string; value: string };
  transaction_initiation_date: string;
  transaction_note?: string;
}

export interface TransactionSearchParams {
  /** PayPal subscription id to look up history for. */
  subscriptionId: string;
  startDate: string; // ISO-8601, e.g. 2025-01-01T00:00:00Z
  endDate: string;
}

/** Orders API v2. */
export interface CreateOrderInput {
  amount: string; // e.g. "39.20"
  currency: string; // e.g. "USD"
  description: string;
  customId?: string;
}

export interface PayPalOrder {
  id: string;
  status: string; // CREATED | COMPLETED | ...
}

export type WebhookHeaders = Record<string, string>;

/** The seam every PayPal capability ChurnSave needs hangs off. */
export interface PayPalGateway {
  readonly name: string;
  /** Buyer purchase history (PayPal: Transaction Search). */
  searchTransactions(params: TransactionSearchParams): Promise<PayPalTransaction[]>;
  /** Create a (discounted) one-off order when the buyer accepts an offer. */
  createOrder(input: CreateOrderInput): Promise<PayPalOrder>;
  captureOrder(orderId: string): Promise<PayPalOrder>;
  /** Verify an incoming webhook signature against PayPal. */
  verifyWebhook(headers: WebhookHeaders, rawBody: string): Promise<boolean>;
}
