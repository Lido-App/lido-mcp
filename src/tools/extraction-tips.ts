export const extractionTipsSchema = {};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

const TIPS = `Advanced refinement for extract_file_data.

These are second-pass techniques. Call this ONLY after an initial extract_file_data call has produced wrong or empty data. Do not use these by default — a first attempt with plain-English instructions is often enough.

When extraction looks wrong, try in this order:

  1. Improve the plain-English \`instructions\`:
     - Name the specific section of the document where each field lives.
     - Spell out formatting, units, currency, and date conventions.
     - Give tie-breaking rules when a field appears multiple times.
     - List sections to exclude (headers, footers, summary/total rows).
  2. Only if the above is not enough, add a directive (see below) to the \`instructions\` string.
  3. Retry extract_file_data with the refined instructions.

# Directive format

Directives go inside the \`instructions\` string, each on its own line, at the bottom of the instructions (after any plain-English guidance), in the form:

  @directive: value

or, for directives with no value:

  @directive

Example \`instructions\` combining plain text with a directive at the bottom:

  Extract line items from the "Service Activity" table only.
  Amounts as plain numbers, no currency symbol.
  @exclude_pages: skip if page contains 'Terms and Conditions'

# Directive reference

## @exclude_pages
Skips pages you don't want turned into output rows. Use when the output contains junk rows from cover sheets, marketing pages, blank pages, or terms-and-conditions pages.

  @exclude_pages: skip if page contains 'Terms and Conditions'
  @exclude_pages: skip if page has no dollar amount
  @exclude_pages: skip if page only has a cover title and no tables or totals

## @parallel
Controls whether the extractor treats each page independently or as a single unit with cross-page context.
  - @parallel:true  — Each page stands on its own (one form or table per page, no dependency on other pages).
  - @parallel:false — Pages depend on each other (e.g. page 1 has a name or header that later pages reference). Works best for documents with at most ~20 pages.

  @parallel:false

## @parallel_extended_context
Tells the extractor to remember a field that appears rarely and reuse it on later pages until a new value is found. Works best alongside @parallel:true.

ONLY add this directive if BOTH conditions hold:
  1. An initial extract_file_data call has already been attempted without it, AND
  2. The observed failure is specifically that a header or label (e.g. "Employee name", "Category", "Table headers") appears once early in the document but applies to many later pages, and those later pages' rows are missing that value or have it misaligned.
Do not add this directive speculatively or as a general-purpose improvement.

  @parallel_extended_context: Employee name
  @parallel_extended_context: Table headers

## @parallel_page_overflow
Allows a table or line-item list to continue across a page break in parallel mode.

ONLY add this directive if BOTH conditions hold:
  1. An initial extract_file_data call has already been attempted without it, AND
  2. The observed failure is specifically that line items or table rows are spread across multiple pages and rows are being dropped at page boundaries (e.g. the last row of page N is missing, or row counts mysteriously dip at page transitions).
Do not add this directive speculatively or as a general-purpose improvement.

  @parallel_page_overflow
  @parallel_page_overflow:false

## @split_file
Breaks one long PDF that actually contains multiple separate documents (e.g. a concatenated batch of invoices) into individual pieces, each extracted on its own. Always requires a value describing where to split.

The value can take two forms:
  - Natural-language predicate — the extractor walks every pair of consecutive pages and asks an LLM whether to split between them based on the rule.
  - Explicit page list — deterministic splits before the given page number(s).

  @split_file: split on every new invoice
  @split_file: pages 2,5,8
  @split_file: page 6
`;

export async function runExtractionTips(): Promise<ToolResult> {
  return { content: [{ type: "text", text: TIPS }] };
}
