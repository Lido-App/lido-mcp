#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { ClientProvider } from "./client-provider.js";
import { Credentials } from "./credentials.js";
import { LidoApiError } from "./lido-client.js";
import { authenticateSchema, runAuthenticate } from "./tools/authenticate.js";
import {
  extractFileDataSchema,
  runExtractFileData,
} from "./tools/extract-file-data.js";
import {
  extractionTipsSchema,
  runExtractionTips,
} from "./tools/extraction-tips.js";
import {
  extractorUsageSchema,
  runExtractorUsage,
} from "./tools/extractor-usage.js";
import { openAppSchema, runOpenApp } from "./tools/open-app.js";
import { openBillingSchema, runOpenBilling } from "./tools/open-billing.js";

const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
const VERSION = pkg.version;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function main() {
  const credentials = new Credentials();
  await credentials.load();

  const mcp = new McpServer({
    name: "lido-mcp",
    version: VERSION,
  });

  const provider = new ClientProvider(credentials, mcp);

  mcp.tool(
    "authenticate",
    "Prompt the user to paste their Lido API key in a local browser form. The key is saved per-project (at <project-root>/.lido-mcp/credentials.json) and is never exposed to the MCP client or the LLM. Call this once per project before using the other tools; subsequent runs pick up the saved key automatically.",
    authenticateSchema,
    (args) => wrapErrors(() => runAuthenticate(mcp, credentials, args)),
  );

  mcp.tool(
    "extract_file_data",
    "Upload a document (PDF, image, etc.) to Lido and extract structured data into the specified columns. Columns can be either fields literally present in the document or AI-derived values computed at extraction time (classifications, conditional codes, lookups, etc.) — so this tool covers both pulling data out and transforming/classifying it in one pass. Writes the full result to a JSON file and returns only the file path — read that file to get the extracted rows. If extracted values come back wrong or empty, retry with more explicit `instructions`; for difficult cases (multi-page tables, batched PDFs, cover-page noise) call `extraction_tips` for advanced refinement techniques before retrying.",
    extractFileDataSchema,
    (args) => wrapErrors(() => runExtractFileData(provider, args)),
  );

  mcp.tool(
    "extraction_tips",
    "Return advanced techniques for refining extract_file_data when an initial call produces wrong or empty results. Do not call this on a first attempt — only after a plain-instructions extraction has failed to produce the expected data.",
    extractionTipsSchema,
    () => wrapErrors(() => runExtractionTips()),
  );

  mcp.tool(
    "extractor_usage",
    "Query your Lido extractor usage quota: pages remaining, pages used in a date range, and optional per-user breakdown. Returns the response as JSON inline.",
    extractorUsageSchema,
    (args) => wrapErrors(() => runExtractorUsage(provider, args)),
  );

  mcp.tool(
    "open_billing_page",
    "Open the user's Lido billing page in a browser. Call this when the user asks to manage their subscription, add credits, or update payment details — and also when an extraction fails because they're out of credits, so they can top up and retry.",
    openBillingSchema,
    () => wrapErrors(() => runOpenBilling(mcp)),
  );

  mcp.tool(
    "open_lido_app",
    "Open the Lido web app in a browser. Call this when the user wants to use Lido's full UI — e.g. to run extractions interactively, manage saved extractors, review historical jobs, or access features not exposed through these MCP tools. Learn more about Lido at https://www.lido.app/.",
    openAppSchema,
    () => wrapErrors(() => runOpenApp(mcp)),
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

async function wrapErrors(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    // Let URLElicitationRequiredError propagate so the SDK converts it into a
    // JSON-RPC error response with code -32042 and the elicitations data.
    if (err instanceof UrlElicitationRequiredError) throw err;

    const message =
      err instanceof LidoApiError
        ? `Lido API error (${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
}

main().catch((err) => {
  process.stderr.write(
    `Fatal error starting Lido MCP server: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
