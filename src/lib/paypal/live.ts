import type { AppConfig } from "../config";
import type {
  CreateOrderInput,
  PayPalGateway,
  PayPalOrder,
  PayPalTransaction,
  TransactionSearchParams,
  WebhookHeaders,
} from "./types";

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * Thin REST adapter over the PayPal APIs ChurnSave needs:
 *  - OAuth2 client-credentials token
 *  - Transaction Search  GET /v1/reporting/transactions
 *  - Orders v2           POST /v2/checkout/orders, POST /v2/checkout/orders/{id}/capture
 *  - Webhook verify      POST /v1/notifications/verify-webhook-signature
 *
 * `fetchImpl` is injectable so unit tests can stub the wire without credentials.
 */
export class LivePayPalGateway implements PayPalGateway {
  readonly name: string;

  private token: TokenCache | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = `paypal-${config.env}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.token;
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error("LivePayPalGateway requires PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET");
    }
    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
    const res = await this.fetchImpl(`${this.config.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`PayPal OAuth failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return this.token.token;
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.config.apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`PayPal ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async searchTransactions(params: TransactionSearchParams): Promise<PayPalTransaction[]> {
    const qs = new URLSearchParams({
      transaction_start_date: params.startDate,
      transaction_end_date: params.endDate,
      fields: "transaction_info",
      page_size: "100",
    });
    const data = await this.call<{ transaction_details?: PayPalTransaction[] }>(
      `/v1/reporting/transactions?${qs.toString()}`,
      { method: "GET" },
    );
    // Filter to this subscription — Transaction Search has no subscription_id filter param.
    return (data.transaction_details ?? []).filter(
      (t) =>
        t.transaction_note?.includes(params.subscriptionId) ||
        t.transaction_id.includes(params.subscriptionId),
    );
  }

  async createOrder(input: CreateOrderInput): Promise<PayPalOrder> {
    return this.call<PayPalOrder>("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: input.description.slice(0, 127),
            custom_id: input.customId,
            amount: { currency_code: input.currency, value: input.amount },
          },
        ],
      }),
    });
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    return this.call<PayPalOrder>(`/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
    });
  }

  async verifyWebhook(headers: WebhookHeaders, rawBody: string): Promise<boolean> {
    if (!this.config.webhookId) {
      throw new Error("PAYPAL_WEBHOOK_ID is required for webhook signature verification");
    }
    const result = await this.call<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        body: JSON.stringify({
          auth_algo: headers["paypal-auth-algo"],
          cert_url: headers["paypal-cert-url"],
          transmission_id: headers["paypal-transmission-id"],
          transmission_sig: headers["paypal-transmission-sig"],
          transmission_time: headers["paypal-transmission-time"],
          webhook_id: this.config.webhookId,
          webhook_event: JSON.parse(rawBody),
        }),
      },
    );
    return result.verification_status === "SUCCESS";
  }
}
