import { describe, it, expect } from "vitest";
import type { QueryResult } from "../types";
import {
  detectExplainMode,
  parsePlanNodes,
  computePlanStats,
  formatMicros,
  formatCount,
} from "./explainPlan";

function makeResult(partial: Partial<QueryResult>): QueryResult {
  return {
    columns: [],
    rows: [],
    executionTime: 1,
    ...partial,
  };
}

const explainResult = makeResult({
  columns: ["id", "operator", "access", "detail"],
  rows: [
    { id: 0, operator: "Project", access: "-", detail: "n.id, n.name" },
    { id: 1, operator: "  NodeScan", access: "index: my_idx", detail: "label=user" },
    { id: 2, operator: "    Filter", access: "-", detail: "n.age > 18" },
  ],
});

const profileResult = makeResult({
  columns: ["id", "operator", "rows", "time(us)", "access", "detail"],
  rows: [
    { id: 0, operator: "Project", rows: 2500, "time(us)": 1340000, access: "-", detail: "out" },
    {
      id: 1,
      operator: "  NodeScan",
      rows: 50000,
      "time(us)": 1200000,
      access: "⚠ FULL SCAN",
      detail: "label=user",
    },
    {
      id: 2,
      operator: "    Filter",
      rows: null,
      "time(us)": null,
      access: "-",
      detail: "n.age>18",
    },
  ],
});

describe("detectExplainMode", () => {
  it("detects PROFILE by its 6-column signature", () => {
    expect(detectExplainMode(profileResult)).toBe("profile");
  });

  it("detects EXPLAIN by its 4-column signature", () => {
    expect(detectExplainMode(explainResult)).toBe("explain");
  });

  it("returns null for ordinary results", () => {
    const normal = makeResult({
      columns: ["name", "age"],
      rows: [{ name: "Alice", age: 30 }],
    });
    expect(detectExplainMode(normal)).toBeNull();
  });

  it("returns null for empty or errored results", () => {
    expect(
      detectExplainMode(makeResult({ columns: ["id", "operator", "access", "detail"] })),
    ).toBeNull();
    expect(
      detectExplainMode(
        makeResult({ columns: ["id", "operator", "access", "detail"], error: "boom" }),
      ),
    ).toBeNull();
  });

  it("does not mistake a 4-column result with different names for EXPLAIN", () => {
    const lookalike = makeResult({
      columns: ["id", "operator", "access", "other"],
      rows: [{ id: 1, operator: "x", access: "y", other: "z" }],
    });
    expect(detectExplainMode(lookalike)).toBeNull();
  });
});

describe("parsePlanNodes", () => {
  it("derives depth from 2-space indentation and trims the operator", () => {
    const nodes = parsePlanNodes(explainResult);
    expect(nodes.map((n) => [n.operator, n.depth])).toEqual([
      ["Project", 0],
      ["NodeScan", 1],
      ["Filter", 2],
    ]);
  });

  it("flags full scans from the access string", () => {
    const nodes = parsePlanNodes(profileResult);
    expect(nodes[0].isFullScan).toBe(false);
    expect(nodes[1].isFullScan).toBe(true);
  });

  it("parses rows/time for PROFILE and leaves them null for EXPLAIN", () => {
    const profile = parsePlanNodes(profileResult);
    expect(profile[1].rows).toBe(50000);
    expect(profile[1].timeUs).toBe(1200000);
    expect(profile[2].rows).toBeNull();
    expect(profile[2].timeUs).toBeNull();

    const explain = parsePlanNodes(explainResult);
    expect(explain[0].rows).toBeNull();
    expect(explain[0].timeUs).toBeNull();
  });
});

describe("computePlanStats", () => {
  it("computes max rows across all nodes", () => {
    const stats = computePlanStats(parsePlanNodes(profileResult));
    expect(stats.maxRows).toBe(50000);
  });

  it("excludes the root node when ranking time and picks the bottleneck", () => {
    const stats = computePlanStats(parsePlanNodes(profileResult));
    // root (id 0) has the largest raw time (1.34s) but must be excluded;
    // the real bottleneck is the NodeScan (id 1).
    expect(stats.maxTimeUs).toBe(1200000);
    expect(stats.bottleneckId).toBe(1);
  });

  it("counts full scans", () => {
    const stats = computePlanStats(parsePlanNodes(profileResult));
    expect(stats.fullScanCount).toBe(1);
  });

  it("returns null bottleneck when there are no timed child nodes", () => {
    const stats = computePlanStats(parsePlanNodes(explainResult));
    expect(stats.bottleneckId).toBeNull();
    expect(stats.maxTimeUs).toBe(0);
  });
});

describe("formatMicros", () => {
  it("formats microseconds, milliseconds and seconds", () => {
    expect(formatMicros(500)).toBe("500µs");
    expect(formatMicros(1500)).toBe("1.50ms");
    expect(formatMicros(45000)).toBe("45.0ms");
    expect(formatMicros(1340000)).toBe("1.34s");
  });

  it("returns empty string for null", () => {
    expect(formatMicros(null)).toBe("");
  });
});

describe("formatCount", () => {
  it("adds thousands separators", () => {
    expect(formatCount(107646)).toBe("107,646");
  });

  it("returns empty string for null", () => {
    expect(formatCount(null)).toBe("");
  });
});
