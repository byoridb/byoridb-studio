import { describe, it, expect } from "vitest";
import type { QueryResult } from "../types";
import { extractLimit, getResultWarning, LARGE_ROW_THRESHOLD } from "./resultWarning";

function makeResult(partial: Partial<QueryResult>): QueryResult {
  return { columns: [], rows: [], executionTime: 1, ...partial };
}

describe("extractLimit", () => {
  it("returns null when there is no LIMIT", () => {
    expect(extractLimit("GO FROM 1 OVER knows YIELD knows._dst")).toBeNull();
    expect(extractLimit(undefined)).toBeNull();
  });

  it("parses a plain LIMIT", () => {
    expect(extractLimit("MATCH (n:person) RETURN n LIMIT 10")).toBe(10);
  });

  it("parses the count from an offset,count LIMIT", () => {
    expect(extractLimit("LOOKUP ON person YIELD person.name | LIMIT 20, 50")).toBe(50);
  });

  it("uses the last LIMIT when several appear (pipes/compound)", () => {
    expect(extractLimit("GO FROM 1 OVER e | LIMIT 100 | YIELD $-.x | LIMIT 5")).toBe(5);
  });

  it("is case-insensitive", () => {
    expect(extractLimit("match (n) return n limit 7")).toBe(7);
  });
});

describe("getResultWarning", () => {
  it("flags a likely-ignored LIMIT as danger", () => {
    const result = makeResult({
      query: "GO FROM 1 OVER knows YIELD knows._dst | LIMIT 10",
      rows: Array(107646).fill({}),
      rowCount: 107646,
    });
    const w = getResultWarning(result);
    expect(w?.level).toBe("danger");
    expect(w?.message).toContain("LIMIT 10");
    expect(w?.message).toContain("107,646");
  });

  it("does not warn when the row count respects the LIMIT", () => {
    const result = makeResult({
      query: "MATCH (n:person) RETURN n LIMIT 10",
      rows: Array(10).fill({}),
      rowCount: 10,
    });
    expect(getResultWarning(result)).toBeNull();
  });

  it("warns when a large result has no LIMIT", () => {
    const result = makeResult({
      query: "MATCH (n:person) RETURN n",
      rows: [],
      rowCount: LARGE_ROW_THRESHOLD,
    });
    const w = getResultWarning(result);
    expect(w?.level).toBe("warning");
    expect(w?.message).toContain("consider adding a LIMIT");
  });

  it("does not warn for a large result that already has a LIMIT respected", () => {
    const result = makeResult({
      query: "MATCH (n) RETURN n LIMIT 50000",
      rowCount: 20000,
    });
    expect(getResultWarning(result)).toBeNull();
  });

  it("does not warn for normal-sized unbounded results", () => {
    const result = makeResult({ query: "MATCH (n) RETURN n", rowCount: 42 });
    expect(getResultWarning(result)).toBeNull();
  });

  it("returns null for errors and empty results", () => {
    expect(getResultWarning(makeResult({ error: "boom", rowCount: 999999 }))).toBeNull();
    expect(getResultWarning(makeResult({ query: "MATCH (n) RETURN n", rowCount: 0 }))).toBeNull();
  });

  it("warns at exactly the threshold but not just below it", () => {
    expect(getResultWarning(makeResult({ rowCount: LARGE_ROW_THRESHOLD }))?.level).toBe("warning");
    expect(getResultWarning(makeResult({ rowCount: LARGE_ROW_THRESHOLD - 1 }))).toBeNull();
  });
});
