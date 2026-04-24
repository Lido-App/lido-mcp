import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import type { Credentials } from "./credentials.js";
import { pollUntilAuthorized, startAuthSession } from "./device-auth.js";
import { LidoClient } from "./lido-client.js";

/**
 * Resolves a LidoClient for tool calls, taking care of authentication.
 *
 * If no credential is available and the client supports URL-mode elicitation,
 * a UrlElicitationRequiredError is thrown so the MCP client can open the
 * verification URL and retry. If the client does not support URL elicitation,
 * a normal error is thrown pointing at the `authenticate` tool.
 */
export class ClientProvider {
  constructor(
    private readonly credentials: Credentials,
    private readonly mcp: McpServer,
  ) {}

  async getClient(): Promise<LidoClient> {
    await this.credentials.ensureResolved(this.mcp);
    const cred = this.credentials.get();
    if (cred) return new LidoClient(cred.apiKey);

    const caps = this.mcp.server.getClientCapabilities();
    if (caps?.elicitation?.url) {
      const elicitationId = randomUUID();
      const session = await startAuthSession();

      // Kick off background polling. We don't await — the thrown error below
      // tells the client to open the URL; when the user submits and polling
      // resolves, the credential is saved and a subsequent tool call picks it
      // up.
      void (async () => {
        try {
          const { apiKey } = await pollUntilAuthorized(session.sessionId, {
            pollIntervalSec: session.pollIntervalSec,
            timeoutMs: session.expiresInSec * 1_000,
          });
          await new LidoClient(apiKey).getExtractorUsage().catch(() => {});
          await this.credentials.save(apiKey);
          try {
            await this.mcp.server
              .createElicitationCompletionNotifier(elicitationId)();
          } catch {
            // optional notification
          }
        } catch {
          // timeout, expired session, or transport error — the user can retry
          // or call `authenticate`.
        }
      })();

      throw new UrlElicitationRequiredError([
        {
          mode: "url",
          elicitationId,
          url: session.verificationUrl,
          message:
            "This Lido MCP server needs an API key. Open the link to paste it on the Lido authorization " +
            "page — the key goes to Lido and back to this MCP server; the MCP client and the LLM never see it.",
        },
      ]);
    }

    throw new Error(
      "Lido API key is not configured. Call the `authenticate` tool to open a browser page where you can " +
        "paste your key, or set the LIDO_API_KEY environment variable in your MCP client config.",
    );
  }
}
