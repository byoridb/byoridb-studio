import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ResultPanel, { formatValue } from "./ResultPanel";

// Clipboard mock
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  configurable: true,
});

// Mock TableView to avoid virtualizer jsdom issues
vi.mock("./GraphView", () => ({
  default: ({ result }: { result: { rows: unknown[] } }) =>
    result.rows.length === 0 ? (
      <div>No graph data detected.</div>
    ) : (
      <div data-testid="graph-canvas" />
    ),
}));

vi.mock("./TableView", () => ({
  default: ({ result }: { result: { columns: string[]; rows: Record<string, unknown>[] } }) => (
    <div data-testid="table-view">
      {result.rows.length === 0 ? (
        <div>No data returned</div>
      ) : (
        <table>
          <thead>
            <tr>
              {result.columns.map((col: string) => (
                <th key={col} data-testid={`col-header-${col}`}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row: Record<string, unknown>, i: number) =>
              result.columns.map((col: string) => (
                <td
                  key={`${i}-${col}`}
                  data-testid={`cell-${i}-${col}`}
                  onClick={() => navigator.clipboard.writeText(String(row[col] ?? "NULL"))}
                >
                  {String(row[col] ?? "NULL")}
                </td>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  ),
}));

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

  it("renders table rows and shows row count and time", () => {
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
    expect(screen.getByTestId("col-header-name")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("switches to JSON tree view", async () => {
    const user = userEvent.setup();
    render(
      <ResultPanel result={{ columns: ["name"], rows: [{ name: "alice" }], executionTime: 1 }} />,
    );
    await user.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByTestId("json-search")).toBeInTheDocument();
    // Single row renders as root object node
    expect(screen.getByTestId("json-node-root")).toBeInTheDocument();
  });

  it("collapses and expands JSON nodes", async () => {
    const user = userEvent.setup();
    render(
      <ResultPanel
        result={{
          columns: ["data"],
          rows: [{ data: { x: 1 } }, { data: { y: 2 } }],
          executionTime: 1,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "JSON" }));
    // Multiple rows → indexed nodes
    const node = screen.getByTestId("json-node-0");
    await user.click(node);
    expect(node).toHaveTextContent("1 keys");
    await user.click(node);
    expect(node).not.toHaveTextContent("1 keys");
  });

  it("shows no-data messaging for successful empty results", () => {
    render(<ResultPanel result={{ columns: ["name"], rows: [], executionTime: 1 }} />);
    expect(screen.getByText("No data returned")).toBeInTheDocument();
  });

  it("prefers server-reported rowCount", () => {
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

  it("shows export buttons", () => {
    render(
      <ResultPanel result={{ columns: ["name"], rows: [{ name: "alice" }], executionTime: 1 }} />,
    );
    expect(screen.getByTestId("export-csv")).toBeInTheDocument();
    expect(screen.getByTestId("export-json")).toBeInTheDocument();
  });

  it("switches to graph view", async () => {
    const user = userEvent.setup();
    render(<ResultPanel result={{ columns: [], rows: [], executionTime: 1 }} />);
    await user.click(screen.getByRole("button", { name: "Graph" }));
    // GraphView renders empty state for no graph data
    expect(screen.getByText("No graph data detected.")).toBeInTheDocument();
  });

  it("warns when a LIMIT appears to have been ignored", () => {
    render(
      <ResultPanel
        result={{
          columns: ["dst"],
          rows: Array(50000).fill({ dst: 1 }),
          executionTime: 5,
          rowCount: 50000,
          query: "GO FROM 1 OVER knows YIELD knows._dst | LIMIT 10",
        }}
      />,
    );
    const banner = screen.getByTestId("result-warning");
    expect(banner.className).toContain("danger");
    expect(banner).toHaveTextContent("LIMIT 10");
  });

  it("does not warn for a normal-sized result", () => {
    render(
      <ResultPanel
        result={{
          columns: ["name"],
          rows: [{ name: "alice" }],
          executionTime: 1,
          rowCount: 1,
          query: "MATCH (n) RETURN n",
        }}
      />,
    );
    expect(screen.queryByTestId("result-warning")).not.toBeInTheDocument();
  });
});
