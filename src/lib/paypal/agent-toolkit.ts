/**
 * Bridge to the official `@paypal/agent-toolkit` (LangChain export).
 *
 * The deterministic pipeline in src/lib/agent decides WHEN to make an offer.
 * This toolkit is the LLM-agent bridge for live mode: it hands LangChain/OpenAI
 * agents PayPal actions (list_transactions, list_disputes, invoices, ...) so
 * the offer strategy can later be upgraded to an LLM negotiating agent without
 * touching PayPal plumbing.
 *
 * Loaded lazily: requires real credentials, so mock/dev/test never touches it.
 */
import type { AppConfig } from "../config";

export interface AgentToolkitInfo {
  available: boolean;
  reason?: string;
  toolNames: string[];
}

/** Tool catalog shown on the dashboard when running without credentials. */
export const MOCK_TOOL_CATALOG = [
  "list_transactions (mocked)",
  "list_disputes (mocked)",
  "create_invoice (mocked)",
  "send_invoice_reminder (mocked)",
];

export async function describeAgentToolkit(config: AppConfig): Promise<AgentToolkitInfo> {
  if (!config.clientId || !config.clientSecret) {
    return {
      available: false,
      reason: "mock mode: set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET to enable live PayPal tools",
      toolNames: MOCK_TOOL_CATALOG,
    };
  }
  try {
    const { PayPalAgentToolkit, ALL_TOOLS_ENABLED } = await import(
      "@paypal/agent-toolkit/langchain"
    );
    const toolkit = new PayPalAgentToolkit({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: config.env === "sandbox" } },
    } as unknown as ConstructorParameters<typeof PayPalAgentToolkit>[0]);
    return { available: true, toolNames: toolkit.getTools().map((t) => t.name) };
  } catch (err) {
    return { available: false, reason: `toolkit init failed: ${String(err)}`, toolNames: [] };
  }
}
