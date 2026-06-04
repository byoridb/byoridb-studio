import { render, screen } from "@testing-library/react";
import ExplainView from "./ExplainView";
import type { QueryResult } from "../types";

function makeResult(partial: Partial<QueryResult>): QueryResult {
  return { columns: [], rows: [], executionTime: 1, ...partial };
}

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
  ],
});

const explainResult = makeResult({
  columns: ["id", "operator", "access", "detail"],
  rows: [
    { id: 0, operator: "Project", access: "-", detail: "n.id" },
    { id: 1, operator: "  NodeScan", access: "index: my_idx", detail: "label=user" },
  ],
});

describe("ExplainView", () => {
  it("renders one row per plan node", () => {
    render(<ExplainView result={profileResult} />);
    expect(screen.getByTestId("plan-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("plan-row-1")).toBeInTheDocument();
  });

  it("shows the PROFILE mode badge and total time", () => {
    render(<ExplainView result={profileResult} />);
    expect(screen.getByText("PROFILE")).toBeInTheDocument();
    // 1.34s appears in both the summary total and the root node's time bar.
    expect(screen.getAllByText("1.34s").length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a full-scan warning and marks the row", () => {
    render(<ExplainView result={profileResult} />);
    expect(screen.getByText(/1 full scan/)).toBeInTheDocument();
    expect(screen.getByTestId("plan-row-1").className).toContain("is-fullscan");
  });

  it("flags the slowest non-root operator as the bottleneck", () => {
    render(<ExplainView result={profileResult} />);
    // Root (id 0, 1.34s) is excluded; NodeScan (id 1, 1.2s) is the bottleneck.
    expect(screen.getByTestId("plan-row-1").className).toContain("is-bottleneck");
    expect(screen.getByTestId("plan-row-0").className).not.toContain("is-bottleneck");
  });

  it("shows the EXPLAIN badge and hints toward PROFILE for plain EXPLAIN", () => {
    render(<ExplainView result={explainResult} />);
    expect(screen.getByText("EXPLAIN")).toBeInTheDocument();
    expect(screen.getByText(/per-operator rows/)).toBeInTheDocument();
  });
});
