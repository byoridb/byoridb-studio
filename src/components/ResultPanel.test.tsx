import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ResultPanel, { formatValue } from "./ResultPanel";

describe("formatValue", () => {
  it("formats empty values as NULL", () => {
    expect(formatValue(null)).toBe("NULL");
    expect(formatValue(undefined)).toBe("NULL");
  });

  it("formats objects as JSON and primitives as strings", () => {
    expect(formatValue({ name: "alice" })).toBe('{"name":"alice"}');
    expect(formatValue(42)).toBe("42");
    expect(formatValue(false)).toBe("false");
  });
});

describe("ResultPanel", () => {
  it("shows an empty state before a query runs", () => {
    render(<ResultPanel result={null} />);

    expect(screen.getByText("Execute a query to see results")).toBeInTheDocument();
  });

  it("renders error results without table controls", () => {
    render(
      <ResultPanel result={{ columns: [], rows: [], executionTime: 0, error: "syntax error" }} />,
    );

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("syntax error")).toBeInTheDocument();
    expect(screen.queryByText("Table")).not.toBeInTheDocument();
  });

  it("renders table rows and switches to JSON view", async () => {
    const user = userEvent.setup();

    render(
      <ResultPanel
        result={{
          columns: ["name", "meta"],
          rows: [{ name: "alice", meta: { active: true } }],
          executionTime: 12.345,
        }}
      />,
    );

    expect(screen.getByText("1 rows")).toBeInTheDocument();
    expect(screen.getByText("12.35ms")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText('{"active":true}')).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "JSON" }));

    expect(screen.getByText(/"active": true/)).toBeInTheDocument();
  });

  it("shows no-data messaging for successful empty results", () => {
    render(<ResultPanel result={{ columns: ["name"], rows: [], executionTime: 1 }} />);

    expect(screen.getByText("No data returned")).toBeInTheDocument();
  });

  it("renders NULL for missing column values", () => {
    render(
      <ResultPanel
        result={{
          columns: ["name", "missing"],
          rows: [{ name: "alice" }],
          executionTime: 1,
        }}
      />,
    );

    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("prefers the server-reported rowCount over the local row array length", () => {
    render(
      <ResultPanel
        result={{
          columns: ["name"],
          rows: [{ name: "alice" }, { name: "bob" }],
          executionTime: 1,
          rowCount: 42,
        }}
      />,
    );

    expect(screen.getByText("42 rows")).toBeInTheDocument();
  });

  it("switches to graph placeholder view", async () => {
    const user = userEvent.setup();

    render(<ResultPanel result={{ columns: [], rows: [], executionTime: 1 }} />);

    await user.click(screen.getByRole("button", { name: "Graph" }));

    expect(screen.getByText("Graph visualization coming soon...")).toBeInTheDocument();
  });
});
