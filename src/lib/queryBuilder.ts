/**
 * Visual MATCH builder → nGQL generation (pure).
 *
 * Assembles a single `MATCH` statement from a form spec. Respects byoridb's
 * constraint that the *start* node must bind a variable (the end node may be
 * anonymous) — we always bind `a` (and `b` when an edge is present).
 */

export type EdgeDirection = "out" | "in" | "both";

export interface BuilderCondition {
  property: string;
  op: string;
  value: string;
}

export interface BuilderEdge {
  name: string;
  direction: EdgeDirection;
}

export interface QueryBuilderSpec {
  startTag: string;
  conditions: BuilderCondition[];
  edge: BuilderEdge | null;
  /** End-node tag; empty string = any/anonymous label. */
  endTag: string;
  limit: number | null;
}

export const BUILDER_OPERATORS = [
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "CONTAINS",
  "STARTS WITH",
] as const;

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Render a condition value: numbers and booleans bare, everything else quoted. */
function renderValue(raw: string): string {
  const v = raw.trim();
  if (v === "") return '""';
  if (NUMERIC.test(v)) return v;
  if (v === "true" || v === "false") return v;
  // Already quoted? leave as-is.
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}

function renderPattern(spec: QueryBuilderSpec): string {
  const start = `(a:${spec.startTag})`;
  if (!spec.edge) return start;

  const end = spec.endTag ? `(b:${spec.endTag})` : "(b)";
  const rel = `[e:${spec.edge.name}]`;
  switch (spec.edge.direction) {
    case "out":
      return `${start}-${rel}->${end}`;
    case "in":
      return `${start}<-${rel}-${end}`;
    case "both":
      return `${start}-${rel}-${end}`;
  }
}

/**
 * Build a MATCH query from the spec, or "" if there is no start tag yet.
 */
export function buildMatchQuery(spec: QueryBuilderSpec): string {
  if (!spec.startTag) return "";

  const pattern = renderPattern(spec);

  const clauses = spec.conditions
    .filter((c) => c.property && c.op)
    .map((c) => `a.${c.property} ${c.op} ${renderValue(c.value)}`);
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

  const returnVars = spec.edge ? "a, b" : "a";
  const limit = spec.limit && spec.limit > 0 ? ` LIMIT ${spec.limit}` : "";

  return `MATCH ${pattern}${where} RETURN ${returnVars}${limit}`;
}
