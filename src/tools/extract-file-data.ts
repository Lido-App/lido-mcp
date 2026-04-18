import { access } from "node:fs/promises";
import { z } from "zod";
import type { ClientProvider } from "../client-provider.js";
import { writeResultFile } from "../output.js";

export const extractFileDataSchema = {
  filePath: z
    .string()
    .describe(
      "Absolute or working-directory-relative path to the document to extract from (PDF, image, etc.). Max 500MB.",
    ),
  columns: z
    .array(z.string())
    .min(1)
    .describe(
      "Names of the fields to produce in the result table, e.g. [\"Invoice Number\", \"Total Amount\", \"Due Date\"]. These define the columns of the table written to the result file. Columns can be either direct extractions from the document OR AI-derived values that don't appear literally in the source — e.g. \"Expense Category\" classified from a free-text description (\"Classify expense description as food, gas, travel, or other\"), or a GL code conditionally derived from another column (\"If status is 'approved', return 99\"). Express the derivation rule either directly in the column name or in the `instructions` parameter. Use short, descriptive names; each column should hold a single atomic value rather than a combined field.",
    ),
  instructions: z
    .string()
    .optional()
    .describe(
      "Optional natural-language extraction guidance. Effective instructions typically cover: output formatting (e.g. \"Dates in ISO 8601\"), unit/currency conventions (e.g. \"Amounts as plain numbers, no currency symbol\"), tie-breaking when a field appears multiple times (e.g. \"Use the invoice total, not the subtotal\"), which sections to include or exclude (e.g. \"Skip header and footer rows\"), and mapping ambiguous columns to specific document landmarks (e.g. \"Service Address is under the 'Customer Location' heading\"). Order matters when describing conditional logic. For advanced refinement on difficult documents, call extraction_tips.",
    ),
  multiRow: z
    .boolean()
    .optional()
    .describe(
      "If true, extract multiple rows (e.g. line items from an invoice). Use true for tabular documents like invoices, purchase orders, or bank statements. Use false (default) for single-entity documents like contracts or receipts.",
    ),
  pageRange: z
    .string()
    .optional()
    .describe(
      "Optional page range, e.g. \"1-3\" or \"1,3,5\". Defaults to all pages. Useful to skip cover pages, terms & conditions, or other irrelevant sections.",
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Optional path where the extracted result should be written as JSON. If omitted, a file is created under the OS tmp directory and the path returned.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(600)
    .optional()
    .describe(
      "Maximum seconds to wait for the extraction job to finish. Defaults to 120.",
    ),
};

type Args = {
  filePath: string;
  columns: string[];
  instructions?: string;
  multiRow?: boolean;
  pageRange?: string;
  outputPath?: string;
  timeoutSeconds?: number;
};

export async function runExtractFileData(
  provider: ClientProvider,
  args: Args,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    await access(args.filePath);
  } catch {
    return errorResult(`File not found: ${args.filePath}`);
  }

  const client = await provider.getClient();
  const { jobId } = await client.submitExtraction(args.filePath, {
    columns: args.columns,
    instructions: args.instructions,
    multiRow: args.multiRow,
    pageRange: args.pageRange,
  });

  const result = await client.pollJobResult(jobId, {
    timeoutMs: (args.timeoutSeconds ?? 120) * 1_000,
  });

  if (result.status === "error") {
    return errorResult(`Lido extraction failed: ${result.error}`);
  }

  const rows = result.data.map((row) =>
    Object.fromEntries(args.columns.map((col, i) => [col, row[i] ?? null])),
  );

  const payload = {
    sourceFile: args.filePath,
    columns: args.columns,
    rowCount: rows.length,
    rows,
  };

  const outPath = await writeResultFile(
    `extract-${jobId}.json`,
    JSON.stringify(payload, null, 2),
    args.outputPath,
  );

  return {
    content: [
      {
        type: "text",
        text: `Extracted ${rows.length} row(s) from ${args.filePath}. Result written to ${outPath} — read that file for the data. If the user complains about the quality of the result, call extraction_tips and investigate whether any of the techniques it describes apply.`,
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
