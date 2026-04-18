import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startAuthServer, StartedAuthServer } from "../auth-server.js";
import { describeLocation, type Credentials } from "../credentials.js";
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
      "Maximum seconds to wait for the user to paste their API key. Defaults to 300.",
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
  const existing = credentials.get();
  if (existing?.source === "env" || existing?.source === "cliFlag") {
    return textResult(
      `Lido API key is already provided via ${existing.source === "env" ? "the LIDO_API_KEY environment variable" : "the --api-key CLI flag"}. ` +
        `Remove it before running authenticate if you want to replace it.`,
    );
  }

  const timeoutMs = (args.timeoutSeconds ?? 300) * 1_000;
  const auth = await startAuthServer({ timeoutMs });
  const supportsUrlElicitation =
    !!mcp.server.getClientCapabilities()?.elicitation?.url;

  try {
    return supportsUrlElicitation
      ? await elicitationFlow(mcp, credentials, auth)
      : await browserFallbackFlow(credentials, auth);
  } finally {
    await auth.stop();
  }
}

async function elicitationFlow(
  mcp: McpServer,
  credentials: Credentials,
  auth: StartedAuthServer,
): Promise<ToolResult> {
  const elicitationId = randomUUID();

  const consent = await mcp.server.elicitInput({
    mode: "url",
    elicitationId,
    url: auth.url,
    message:
      "Open this local page to paste your Lido API key. The key stays on your machine " +
      "and is never sent to the MCP client or the LLM.",
  });

  if (consent.action !== "accept") {
    return textResult(
      consent.action === "decline"
        ? "Authentication declined. No credentials were stored."
        : "Authentication cancelled. No credentials were stored.",
    );
  }

  const apiKey = await auth.waitForKey();
  const saveResult = await verifyAndSave(credentials, apiKey);
  if (saveResult.isError) return saveResult;

  try {
    await mcp.server.createElicitationCompletionNotifier(elicitationId)();
  } catch {
    // client may not support the notification; not fatal
  }

  return saveResult;
}

async function browserFallbackFlow(
  credentials: Credentials,
  auth: StartedAuthServer,
): Promise<ToolResult> {
  const opened = await openBrowser(auth.url);

  const intro = opened.opened
    ? `Opened your browser to a local sign-in page. If the tab didn't appear, copy and paste this URL manually:\n\n  ${auth.url}\n\nPaste your Lido API key in that page. Waiting up to 5 minutes for you to submit…`
    : `Couldn't auto-open a browser (${opened.reason ?? "unknown"}). Open this URL manually on this machine to paste your Lido API key:\n\n  ${auth.url}\n\nWaiting up to 5 minutes for you to submit…`;

  // Return partial progress as a single tool result once the flow resolves.
  try {
    const apiKey = await auth.waitForKey();
    const saveResult = await verifyAndSave(credentials, apiKey);
    if (saveResult.isError) {
      return {
        isError: true,
        content: [
          { type: "text", text: `${intro}\n\n${saveResult.content[0].text}` },
        ],
      };
    }
    return {
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
      `The API key was captured but failed a verification call to Lido: ${
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
