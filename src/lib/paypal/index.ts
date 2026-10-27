import type { AppConfig } from "../config";
import { LivePayPalGateway } from "./live";
import { MockPayPalGateway } from "./mock";
import type { PayPalGateway } from "./types";

export * from "./types";
export { MockPayPalGateway } from "./mock";
export { LivePayPalGateway } from "./live";

/** Pick the gateway for the current config: mock unless real credentials exist. */
export function createGateway(config: AppConfig): PayPalGateway {
  if (config.mockMode) return new MockPayPalGateway();
  return new LivePayPalGateway(config);
}
