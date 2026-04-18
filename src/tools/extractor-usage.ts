import { z } from "zod";
import type { ClientProvider } from "../client-provider.js";

export const extractorUsageSchema = {
  startDate: z
    .string()
    .optional()
    .describe(
      "Optional ISO 8601 timestamp (e.g. 2026-01-01T00:00:00Z). When set, the response will also include pagesUsed.",
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "Optional ISO 8601 timestamp. Defaults to the current time. Only meaningful with startDate.",
    ),
  byUser: z
    .boolean()
    .optional()
    .describe(
      "If true, return a per-user breakdown of usage. Requires startDate.",
    ),
};

type Args = {
  startDate?: string;
  endDate?: string;
  byUser?: boolean;
};

export async function runExtractorUsage(
  provider: ClientProvider,
  args: Args,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  if (args.byUser && !args.startDate) {
    return {
      isError: true,
      content: [
        { type: "text", text: "byUser=true requires startDate to be set." },
      ],
    };
  }

  const client = await provider.getClient();
  const usage = await client.getExtractorUsage({
    startDate: args.startDate,
    endDate: args.endDate,
    byUser: args.byUser,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(usage, null, 2) }],
  };
}
