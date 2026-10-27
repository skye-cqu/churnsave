/**
 * Lazily-created app singletons. Tests bypass this module and wire their own
 * store/gateway directly into handlePayPalWebhook / acceptOffer.
 */
import { ChurnStore } from "../db/store";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { createGateway, type PayPalGateway } from "./paypal";
import { createLlmProvider, loadLlmConfig, type LlmProvider } from "./agent/llm";

const DB_FILE = process.env.CHURNSAVE_DB ?? "churnsave.db";

const globalStore = globalThis as unknown as {
  __churnsaveStore?: ChurnStore;
  __churnsaveConfig?: AppConfig;
  __churnsaveGateway?: PayPalGateway;
  __churnsaveLlm?: LlmProvider;
};

export function getStore(): ChurnStore {
  globalStore.__churnsaveStore ??= ChurnStore.fromFile(DB_FILE);
  return globalStore.__churnsaveStore;
}

export function getConfig(): AppConfig {
  globalStore.__churnsaveConfig ??= loadConfig();
  return globalStore.__churnsaveConfig;
}

export function getGateway(): PayPalGateway {
  globalStore.__churnsaveGateway ??= createGateway(getConfig());
  return globalStore.__churnsaveGateway;
}

/** LLM decision-layer provider (Nebius when NEBIUS_API_KEY is set, Mock otherwise). */
export function getLlm(): LlmProvider {
  globalStore.__churnsaveLlm ??= createLlmProvider(loadLlmConfig());
  return globalStore.__churnsaveLlm;
}
