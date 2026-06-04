/**
 * EXPLAIN / PROFILE result parsing.
 *
 * The byoridb server renders EXPLAIN/PROFILE as a plain row-major DataSet
 * (no special envelope). It encodes the operator tree with 2-space-per-depth
 * indentation in the `operator` column, in preorder. These pure helpers detect
 * such a result by its column signature and rebuild the tree for visualization.
 *
 * Column signatures (see byoridb-executor/src/explain.rs::render):
 *   EXPLAIN: ["id", "operator", "access", "detail"]
 *   PROFILE: ["id", "operator", "rows", "time(us)", "access", "detail"]
 */
import type { QueryResult } from "../types";

export type ExplainMode = "explain" | "profile";

export interface PlanNode {
  /** Sequential id assigned by the server (preorder). */
  id: number;
  /** Operator name, trimmed of indentation. */
  operator: string;
  /** Tree depth derived from the operator column's leading indentation. */
  depth: number;
  /** Access-path display string, e.g. "index: foo", "⚠ FULL SCAN", "-". */
  access: string;
  /** Whether this node does an un-indexed full scan. */
  isFullScan: boolean;
  /** Free-form operator detail (predicates, projected columns, …). */
  detail: string;
  /** PROFILE only: actual row count flowing through this operator. */
  rows: number | null;
  /** PROFILE only: time spent in this operator, in microseconds. */
  timeUs: number | null;
}

const EXPLAIN_COLUMNS = ["id", "operator", "access", "detail"];
const PROFILE_COLUMNS = ["id", "operator", "rows", "time(us)", "access", "detail"];

function columnsMatch(columns: string[], signature: string[]): boolean {
  return columns.length === signature.length && signature.every((c, i) => columns[i] === c);
}

/**
 * Detect whether a query result is an EXPLAIN or PROFILE plan, based purely on
 * its column signature. Returns null for ordinary query results.
 */
export function detectExplainMode(result: QueryResult): ExplainMode | null {
  if (result.error || result.rows.length === 0) return null;
  if (columnsMatch(result.columns, PROFILE_COLUMNS)) return "profile";
  if (columnsMatch(result.columns, EXPLAIN_COLUMNS)) return "explain";
  return null;
}

function leadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === " ") n += 1;
  return n;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Rebuild the plan node list (flat, in preorder, each carrying its `depth`)
 * from an EXPLAIN/PROFILE result. The server indents `operator` by 2 spaces
 * per level, so depth = leadingSpaces / 2.
 */
export function parsePlanNodes(result: QueryResult): PlanNode[] {
  return result.rows.map((row, i) => {
    const rawOperator = String(row.operator ?? "");
    const depth = Math.floor(leadingSpaces(rawOperator) / 2);
    const access = String(row.access ?? "-");
    return {
      id: toNumber(row.id) ?? i,
      operator: rawOperator.trim(),
      depth,
      access,
      isFullScan: access.includes("FULL SCAN"),
      detail: String(row.detail ?? ""),
      rows: "rows" in row ? toNumber(row.rows) : null,
      timeUs: "time(us)" in row ? toNumber(row["time(us)"]) : null,
    };
  });
}

export interface PlanStats {
  /** Largest per-operator row count (PROFILE), for heatmap scaling. */
  maxRows: number;
  /**
   * Largest per-operator time, EXCLUDING the root output node whose time is the
   * whole-query wall clock and would otherwise dwarf every real operator.
   */
  maxTimeUs: number;
  /** id of the slowest non-root operator (the bottleneck), or null. */
  bottleneckId: number | null;
  /** Count of operators doing a full scan. */
  fullScanCount: number;
}

export function computePlanStats(nodes: PlanNode[]): PlanStats {
  let maxRows = 0;
  let maxTimeUs = 0;
  let bottleneckId: number | null = null;
  let fullScanCount = 0;

  for (const n of nodes) {
    if (n.rows !== null && n.rows > maxRows) maxRows = n.rows;
    if (n.isFullScan) fullScanCount += 1;
    // Skip the root (depth 0) when ranking time: its value is the total
    // wall-clock, not a single operator's cost.
    if (n.depth > 0 && n.timeUs !== null && n.timeUs > maxTimeUs) {
      maxTimeUs = n.timeUs;
      bottleneckId = n.id;
    }
  }

  return { maxRows, maxTimeUs, bottleneckId, fullScanCount };
}

/** Format a microsecond duration into a compact human string. */
export function formatMicros(us: number | null): string {
  if (us === null) return "";
  if (us < 1000) return `${us}µs`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format a row count with thousands separators. */
export function formatCount(n: number | null): string {
  if (n === null) return "";
  return n.toLocaleString("en-US");
}
