import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export type StartedAuthServer = {
  url: string;
  stop: () => Promise<void>;
  waitForKey: () => Promise<string>;
};

type Options = {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT = 5 * 60_000;

export async function startAuthServer(
  opts: Options = {},
): Promise<StartedAuthServer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const token = randomBytes(32).toString("hex");

  let resolveKey: (k: string) => void;
  let rejectKey: (e: Error) => void;
  const keyPromise = new Promise<string>((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });

  const server: Server = createServer((req, res) => {
    handle(req, res, token, (k) => resolveKey(k)).catch((err) => {
      writeJson(res, 500, { error: err.message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/auth/${token}`;

  const timeout = setTimeout(() => {
    rejectKey(new Error(`Authentication timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref();

  const stop = async () => {
    clearTimeout(timeout);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    url,
    stop,
    waitForKey: async () => {
      try {
        return await keyPromise;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  onKey: (apiKey: string) => void,
): Promise<void> {
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
    writeText(res, 403, "Forbidden (host mismatch)");
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'");
  res.setHeader("Connection", "close");

  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (req.method === "GET" && url.pathname === `/auth/${token}`) {
    writeHtml(res, 200, formPage(token));
    return;
  }

  if (req.method === "POST" && url.pathname === `/auth/${token}/submit`) {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const apiKey = params.get("apiKey")?.trim();
    if (!apiKey) {
      writeHtml(res, 400, formPage(token, "Please paste your API key."));
      return;
    }
    writeHtml(res, 200, successPage());
    onKey(apiKey);
    return;
  }

  writeText(res, 404, "Not found");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 64 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function writeText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function formPage(token: string, error?: string): string {
  const errorHtml = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Lido MCP — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 460px; margin: 64px auto; padding: 0 24px; }
  h1 { margin-top: 0; font-size: 1.5rem; }
  p { line-height: 1.5; color: #444; }
  @media (prefers-color-scheme: dark) { p { color: #bbb; } }
  label { display: block; font-weight: 600; margin-top: 24px; margin-bottom: 8px; }
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 1rem; border: 1px solid #888; border-radius: 6px; background: transparent; color: inherit; }
  button { margin-top: 16px; padding: 10px 18px; font-size: 1rem; border: 0; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { background: #eee; color: #111; } }
  .error { color: #c00; }
  .hint { font-size: 0.85rem; color: #666; }
  @media (prefers-color-scheme: dark) { .hint { color: #999; } }
</style>
</head>
<body>
<h1>Connect Lido to your MCP client</h1>
<p>Paste your Lido API key to let this MCP server call the Lido API on your behalf. The key is stored locally on this machine and is never exposed to the MCP client or the LLM.</p>
${errorHtml}
<form method="POST" action="/auth/${escapeHtml(token)}/submit" autocomplete="off">
  <label for="apiKey">Lido API key</label>
  <input id="apiKey" name="apiKey" type="password" required autofocus spellcheck="false">
  <p class="hint">Find or create one in your Lido account settings.</p>
  <button type="submit">Connect</button>
</form>
</body>
</html>`;
}

function successPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Lido MCP — Connected</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 460px; margin: 64px auto; padding: 0 24px; }
  h1 { margin-top: 0; font-size: 1.5rem; }
  p { line-height: 1.5; color: #444; }
  @media (prefers-color-scheme: dark) { p { color: #bbb; } }
</style>
</head>
<body>
<h1>Connected ✓</h1>
<p>Your Lido API key has been saved locally. You can close this tab and return to your MCP client.</p>
</body>
</html>`;
}
