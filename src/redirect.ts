import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openBrowser } from "./open-browser.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Send the user to an external URL. Tries URL-mode elicitation first (the
 * MCP-spec-compliant way to ask the client to open a link); for clients that
 * don't support it, falls back to `openBrowser()`. Always includes the URL in
 * the returned text so the agent can surface it if both paths fail.
 */
export async function actionRedirect(
  mcp: McpServer,
  opts: { url: string; message: string; summary: string },
): Promise<ToolResult> {
  const { url, message, summary } = opts;
  const supportsUrlElicitation =
    !!mcp.server.getClientCapabilities()?.elicitation?.url;

  if (supportsUrlElicitation) {
    try {
      const consent = await mcp.server.elicitInput({
        mode: "url",
        elicitationId: randomUUID(),
        url,
        message,
      });
      if (consent.action === "accept") {
        return textResult(`${summary}\n\n${url}`);
      }
      return textResult(
        `${summary}\n\nThe user declined to open the page automatically. Share this link with them:\n\n  ${url}`,
      );
    } catch {
      // fall through to openBrowser
    }
  }

  const opened = await openBrowser(url);
  return textResult(
    opened.opened
      ? `${summary}\n\nOpened your browser to:\n\n  ${url}`
      : `${summary}\n\nCouldn't auto-open a browser (${opened.reason ?? "unknown"}). Open this URL manually:\n\n  ${url}`,
  );
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
