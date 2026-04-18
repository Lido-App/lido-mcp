import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = "https://sheets.lido.app/api/v1";

export type ExtractConfig = {
  columns: string[];
  instructions?: string;
  multiRow?: boolean;
  pageRange?: string;
};

export type ExtractJobResponse = {
  status: "running" | "success" | "error";
  jobId?: string;
  error?: string;
};

export type JobResult =
  | { status: "running" }
  | { status: "success"; data: string[][] }
  | { status: "error"; error: string };

export type UsageQuery = {
  startDate?: string;
  endDate?: string;
  byUser?: boolean;
};

export type UsageResponse = {
  pagesRemaining: number;
  pagesUsed?: number;
  usageByUser?: Array<{ userId: string; email: string; pagesUsed: number }>;
};

export class LidoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "LidoApiError";
  }
}

export class LidoClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("Lido API key is required");
  }

  async submitExtraction(
    filePath: string,
    config: ExtractConfig,
  ): Promise<{ jobId: string }> {
    const fileBuffer = await readFile(filePath);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(fileBuffer)]),
      basename(filePath),
    );
    form.append("config", JSON.stringify(config));

    const res = await fetch(`${BASE_URL}/extract-file-data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    const body = (await this.parseJson(res)) as ExtractJobResponse;
    if (!res.ok || !body.jobId) {
      throw new LidoApiError(
        body.error ?? `Extraction request failed with status ${res.status}`,
        res.status,
        body,
      );
    }
    return { jobId: body.jobId };
  }

  async getJobResult(jobId: string): Promise<JobResult> {
    const url = new URL(`${BASE_URL}/job-result`);
    url.searchParams.set("jobId", jobId);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    const body = (await this.parseJson(res)) as JobResult;
    if (!res.ok) {
      throw new LidoApiError(
        (body as { error?: string }).error ??
          `Job result request failed with status ${res.status}`,
        res.status,
        body,
      );
    }
    return body;
  }

  async pollJobResult(
    jobId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Extract<JobResult, { status: "success" | "error" }>> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;

    await sleep(2_000, options.signal);
    let delay = 2_000;

    while (Date.now() < deadline) {
      const result = await this.getJobResult(jobId);
      if (result.status !== "running") return result;
      await sleep(delay, options.signal);
      delay = Math.min(delay * 1.5, 8_000);
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for Lido job ${jobId}`,
    );
  }

  async getExtractorUsage(query: UsageQuery = {}): Promise<UsageResponse> {
    const url = new URL(`${BASE_URL}/extractor-usage`);
    if (query.startDate) url.searchParams.set("start_date", query.startDate);
    if (query.endDate) url.searchParams.set("end_date", query.endDate);
    if (query.byUser) url.searchParams.set("by_user", "true");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    const body = (await this.parseJson(res)) as UsageResponse & {
      error?: string;
    };
    if (!res.ok) {
      throw new LidoApiError(
        body.error ?? `Usage request failed with status ${res.status}`,
        res.status,
        body,
      );
    }
    return body;
  }

  private async parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  }
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
