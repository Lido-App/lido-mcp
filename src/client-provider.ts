import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { startAuthServer } from "./auth-server.js";
import type { Credentials } from "./credentials.js";
import { LidoClient } from "./lido-client.js";

/**
 * Resolves a LidoClient for tool calls, taking care of authentication.
 *
 * If no credential is available and the client supports URL-mode elicitation,
 * a UrlElicitationRequiredError is thrown so the MCP client can open the
 * auth URL and retry. If the client does not support URL elicitation, a
 * normal error is thrown pointing at the LIDO_API_KEY env var.
 */
export class ClientProvider {
  constructor(
    private readonly credentials: Credentials,
    private readonly mcp: McpServer,
  ) {}

  async getClient(): Promise<LidoClient> {
    const cred = this.credentials.get();
    if (cred) return new LidoClient(cred.apiKey);

    const caps = this.mcp.server.getClientCapabilities();
    if (caps?.elicitation?.url) {
      const elicitationId = randomUUID();
      const auth = await startAuthServer();
      // The server must point the client at the URL; completion will happen
      // after the user submits their key. We intentionally don't await the
      // key here — the error tells the client to retry the tool call, at
      // which point the credential will already be saved by the background
      // flow below.
      void (async () => {
        try {
          const apiKey = await auth.waitForKey();
          await new LidoClient(apiKey).getExtractorUsage().catch(() => {});
          await this.credentials.save(apiKey);
          try {
            await this.mcp.server
              .createElicitationCompletionNotifier(elicitationId)();
          } catch {
            // optional notification
          }
        } catch {
          // timeout or aborted — client can retry / call authenticate
        } finally {
          await auth.stop();
        }
      })();

      throw new UrlElicitationRequiredError([
        {
          mode: "url",
          elicitationId,
          url: auth.url,
          message:
            "This Lido MCP server needs an API key. Open the link to paste it securely — the key stays on your machine and will not pass through the MCP client.",
        },
      ]);
    }

    throw new Error(
      "Lido API key is not configured. Call the `authenticate` tool to open a local " +
        "browser page where you can paste your key, or set the LIDO_API_KEY environment " +
        "variable in your MCP client config.",
    );
  }
}
