/**
 * Large-result / ignored-LIMIT warnings for the result panel.
 *
 * Motivation (see aidlc-docs/studio-improvement-plan.md, item A1): a benchmark
 * found byoridb returning 107,646 rows for a query that carried `LIMIT 10`.
 * A user staring at a 10k-row grid has no cheap way to notice that. These pure
 * helpers turn the row count (and, when available, the source query) into an
 * actionable banner.
 */
import type { QueryResult } from "../types";

/** Above this row count, an unbounded query is worth warning about. */
export const LARGE_ROW_THRESHOLD = 10_000;

export interface ResultWarning {
  /** "danger" = a LIMIT was likely ignored; "warning" = just a big result. */
  level: "danger" | "warning";
  message: string;
}

/**
 * Extract the effective row limit from an nGQL query, or null if none.
 * Handles both `LIMIT <count>` and `LIMIT <offset>, <count>`; when several
 * LIMIT clauses appear (pipes / compound statements), the last one wins, which
 * is the one bounding the final output.
 */
export function extractLimit(query: string | undefined): number | null {
  if (!query) return null;
  const matches = [...query.matchAll(/\blimit\s+(?:\d+\s*,\s*)?(\d+)\b/gi)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Decide whether a successful result deserves a warning banner.
 * Returns null for errors, empty results, and normal-sized results.
 */
export function getResultWarning(
  result: QueryResult,
  threshold: number = LARGE_ROW_THRESHOLD,
): ResultWarning | null {
  if (result.error) return null;

  const rowCount = result.rowCount ?? result.rows.length;
  if (rowCount === 0) return null;

  const limit = extractLimit(result.query);

  // A LIMIT was requested but the server returned more rows than that — the
  // strongest signal, regardless of absolute size.
  if (limit !== null && rowCount > limit) {
    return {
      level: "danger",
      message: `Query specified LIMIT ${formatCount(limit)} but ${formatCount(
        rowCount,
      )} rows were returned — the server may not have applied the LIMIT.`,
    };
  }

  // No LIMIT and a large result — encourage bounding it.
  if (limit === null && rowCount >= threshold) {
    return {
      level: "warning",
      message: `${formatCount(
        rowCount,
      )} rows returned — consider adding a LIMIT clause to bound the result.`,
    };
  }

  return null;
}
