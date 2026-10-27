/**
 * Central runtime configuration. Everything degrades gracefully to mock mode
 * so the whole closed loop runs (and tests pass) without real PayPal credentials.
 */
export interface AppConfig {
  /** "sandbox" (default) or "live". */
  env: "sandbox" | "live";
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  /** True when we should use the in-process mock gateway instead of the PayPal REST API. */
  mockMode: boolean;
  apiBase: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const clientId = env.PAYPAL_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() || undefined;
  const payPalEnv: "sandbox" | "live" = env.PAYPAL_ENV === "live" ? "live" : "sandbox";
  const forcedMock = env.PAYPAL_MOCK === "1" || env.PAYPAL_MOCK === "true";
  const mockMode = forcedMock || !clientId || !clientSecret;
  return {
    env: payPalEnv,
    clientId,
    clientSecret,
    webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
    mockMode,
    apiBase:
      payPalEnv === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com",
  };
}
