import { getApiBaseUrl } from "./config.js";

export type StartResponse = {
  sessionId: string;
  verificationUrl: string;
  pollIntervalSec: number;
  expiresInSec: number;
};

type PendingStatus = {
  status: "pending";
  pollIntervalSec: number;
  expiresInSec: number;
};
type AuthorizedStatus = { status: "authorized"; apiKey: string };
type ExpiredStatus = { status: "expired" };
export type StatusResponse =
  | PendingStatus
  | AuthorizedStatus
  | ExpiredStatus;

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Rate limited; retry after ${retryAfterSec}s`);
    this.name = "RateLimitedError";
  }
}

export class PermanentAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentAuthError";
  }
}

export async function startAuthSession(): Promise<StartResponse> {
  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}/mcp/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    throw new Error(
      `Could not reach Lido to start an authorization session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Failed to start Lido auth session: HTTP ${res.status}${await errorBody(res)}`,
    );
  }
  return (await res.json()) as StartResponse;
}

export async function getAuthStatus(
  sessionId: string,
): Promise<StatusResponse> {
  const url = new URL(`${getApiBaseUrl()}/mcp/auth/status`);
  url.searchParams.set("sessionId", sessionId);
  const res = await fetch(url);
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After"));
    throw new RateLimitedError(
      Number.isFinite(retry) && retry > 0 ? retry : 5,
    );
  }
  if (res.status >= 400 && res.status < 500) {
    throw new PermanentAuthError(
      `Lido rejected the auth status request: HTTP ${res.status}${await errorBody(res)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Auth status request failed: HTTP ${res.status}${await errorBody(res)}`,
    );
  }
  return (await res.json()) as StatusResponse;
}

export type PollOptions = {
  pollIntervalSec: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export async function pollUntilAuthorized(
  sessionId: string,
  opts: PollOptions,
): Promise<{ apiKey: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  const floorMs = floorInterval(opts.pollIntervalSec);
  let waitMs = floorMs;
  let backoffMs = floorMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(waitMs, remaining), opts.signal);
    if (Date.now() >= deadline) break;

    try {
      const status = await getAuthStatus(sessionId);
      if (status.status === "authorized") return { apiKey: status.apiKey };
      if (status.status === "expired") {
        throw new PermanentAuthError(
          "Authorization session expired before the user submitted a key.",
        );
      }
      waitMs = floorInterval(status.pollIntervalSec);
      backoffMs = waitMs;
    } catch (err) {
      if (err instanceof PermanentAuthError) throw err;
      if (err instanceof RateLimitedError) {
        waitMs = Math.max(floorMs, err.retryAfterSec * 1000);
        continue;
      }
      // Transient (5xx or network) — exponential backoff, floored at pollIntervalSec.
      backoffMs = Math.min(backoffMs * 2, 30_000);
      waitMs = Math.max(backoffMs, floorMs);
    }
  }
  throw new Error(
    `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for the user to authorize the MCP session.`,
  );
}

function floorInterval(pollIntervalSec: number): number {
  if (!Number.isFinite(pollIntervalSec) || pollIntervalSec <= 0) return 2_000;
  return Math.max(1_000, Math.floor(pollIntervalSec * 1_000));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function errorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` — ${text}` : "";
  } catch {
    return "";
  }
}
