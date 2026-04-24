import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeLocation, type Credentials } from "../credentials.js";
import {
  pollUntilAuthorized,
  startAuthSession,
  type StartResponse,
} from "../device-auth.js";
import { LidoClient } from "../lido-client.js";
import { openBrowser } from "../open-browser.js";

export const authenticateSchema = {
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(900)
    .optional()
    .describe(
      "Maximum seconds to wait for the user to authorize the MCP session in their browser. Defaults to 900 (15 minutes), which matches the server-side session TTL.",
    ),
};

type Args = { timeoutSeconds?: number };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export async function runAuthenticate(
  mcp: McpServer,
  credentials: Credentials,
  args: Args,
): Promise<ToolResult> {
  await credentials.ensureResolved(mcp);
  const existing = credentials.get();
  if (existing?.source === "env" || existing?.source === "cliFlag") {
    return textResult(
      `Lido API key is already provided via ${existing.source === "env" ? "the LIDO_API_KEY environment variable" : "the --api-key CLI flag"}. ` +
        `Remove it before running authenticate if you want to replace it.`,
    );
  }

  const timeoutMs = (args.timeoutSeconds ?? 900) * 1_000;
  const session = await startAuthSession();
  const supportsUrlElicitation =
    !!mcp.server.getClientCapabilities()?.elicitation?.url;

  return supportsUrlElicitation
    ? await elicitationFlow(mcp, credentials, session, timeoutMs)
    : await browserFallbackFlow(credentials, session, timeoutMs);
}

async function elicitationFlow(
  mcp: McpServer,
  credentials: Credentials,
  session: StartResponse,
  timeoutMs: number,
): Promise<ToolResult> {
  const elicitationId = randomUUID();

  const consent = await mcp.server.elicitInput({
    mode: "url",
    elicitationId,
    url: session.verificationUrl,
    message:
      "Open this page to connect your Lido account to the MCP server. Paste your Lido API key on that page — " +
      "it will be returned to this MCP server and stored locally; the MCP client and the LLM never see it.",
  });

  if (consent.action !== "accept") {
    return textResult(
      consent.action === "decline"
        ? "Authentication declined. No credentials were stored."
        : "Authentication cancelled. No credentials were stored.",
    );
  }

  const { apiKey } = await pollUntilAuthorized(session.sessionId, {
    pollIntervalSec: session.pollIntervalSec,
    timeoutMs,
  });
  const saveResult = await verifyAndSave(credentials, apiKey);

  try {
    await mcp.server.createElicitationCompletionNotifier(elicitationId)();
  } catch {
    // client may not support the notification; not fatal
  }

  return saveResult;
}

async function browserFallbackFlow(
  credentials: Credentials,
  session: StartResponse,
  timeoutMs: number,
): Promise<ToolResult> {
  const opened = await openBrowser(session.verificationUrl);
  const waitMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
  const intro = opened.opened
    ? `Opened your browser to the Lido authorization page. If the tab didn't appear, open this URL manually:\n\n  ${session.verificationUrl}\n\nPaste your Lido API key on that page. Waiting up to ${waitMinutes} minute(s) for you to submit…`
    : `Couldn't auto-open a browser (${opened.reason ?? "unknown"}). Open this URL manually to paste your Lido API key:\n\n  ${session.verificationUrl}\n\nWaiting up to ${waitMinutes} minute(s) for you to submit…`;

  try {
    const { apiKey } = await pollUntilAuthorized(session.sessionId, {
      pollIntervalSec: session.pollIntervalSec,
      timeoutMs,
    });
    const saveResult = await verifyAndSave(credentials, apiKey);
    return {
      ...(saveResult.isError ? { isError: true } : {}),
      content: [
        { type: "text", text: `${intro}\n\n${saveResult.content[0].text}` },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${intro}\n\nAuthentication did not complete: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }
}

async function verifyAndSave(
  credentials: Credentials,
  apiKey: string,
): Promise<ToolResult> {
  try {
    await new LidoClient(apiKey).getExtractorUsage();
  } catch (err) {
    return errorResult(
      `Lido returned a key, but it failed a verification call: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const savedAt = await credentials.save(apiKey);
  const loc = credentials.location_();
  const where = loc ? describeLocation(loc) : savedAt;
  return textResult(
    `Lido API key saved to ${savedAt} — ${where}. You can now call extract_file_data and extractor_usage.`,
  );
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
