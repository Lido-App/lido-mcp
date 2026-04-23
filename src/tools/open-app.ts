import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBaseUrl } from "../config.js";
import { actionRedirect } from "../redirect.js";

export const openAppSchema = {};

export async function runOpenApp(mcp: McpServer) {
  const url = getBaseUrl();
  return actionRedirect(mcp, {
    url,
    message:
      "Open the Lido web app to run extractions in the UI, manage saved extractors, or access features not exposed through the MCP tools.",
    summary: "Opening the Lido web app.",
  });
}
