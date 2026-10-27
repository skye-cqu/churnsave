import { describeAgentToolkit } from "@/lib/paypal/agent-toolkit";
import { getConfig } from "@/lib/runtime";

/** Introspection endpoint: which PayPal agent tools would the LLM bridge get? */
export async function GET(): Promise<Response> {
  const info = await describeAgentToolkit(getConfig());
  return Response.json(info);
}
