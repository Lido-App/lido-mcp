import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBaseUrl } from "../config.js";
import { actionRedirect } from "../redirect.js";

export const openBillingSchema = {};

export async function runOpenBilling(mcp: McpServer) {
  const url = `${getBaseUrl()}/settings/billing`;
  return actionRedirect(mcp, {
    url,
    message:
      "Open the Lido billing page to manage your plan, add credits, or update payment details.",
    summary: "Opening the Lido billing page.",
  });
}
