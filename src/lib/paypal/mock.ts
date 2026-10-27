import type {
  CreateOrderInput,
  PayPalGateway,
  PayPalOrder,
  PayPalTransaction,
  TransactionSearchParams,
  WebhookHeaders,
} from "./types";

/**
 * In-memory PayPal gateway used for local dev, demos and tests.
 * Same interface as the live gateway: the agent layer cannot tell the difference.
 */
export class MockPayPalGateway implements PayPalGateway {
  readonly name = "mock";

  private orderSeq = 0;
  private readonly orders = new Map<string, PayPalOrder>();

  constructor(
    /** Return value for searchTransactions, keyed by subscription id. */
    private readonly history: Record<string, PayPalTransaction[]> = {},
    private readonly verifyResult = true,
  ) {}

  async searchTransactions(params: TransactionSearchParams): Promise<PayPalTransaction[]> {
    return this.history[params.subscriptionId] ?? [];
  }

  async createOrder(input: CreateOrderInput): Promise<PayPalOrder> {
    this.orderSeq += 1;
    const order: PayPalOrder = {
      id: `MOCK-ORDER-${String(this.orderSeq).padStart(4, "0")}`,
      status: "CREATED",
    };
    this.orders.set(order.id, order);
    return order;
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`mock gateway: unknown order ${orderId}`);
    order.status = "COMPLETED";
    return order;
  }

  async verifyWebhook(_headers: WebhookHeaders, _rawBody: string): Promise<boolean> {
    return this.verifyResult;
  }
}
