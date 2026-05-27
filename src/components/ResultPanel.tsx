import { useState } from "react";

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime: number;
  /** Server-reported row count (byoridb `QueryResponse.row_count`); falls back to `rows.length` if absent. */
  rowCount?: number;
  error?: string;
}

interface ResultPanelProps {
  result: QueryResult | null;
}

type ViewMode = "table" | "json" | "graph";

function ResultPanel({ result }: ResultPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("table");

  if (!result) {
    return (
      <div className="flex-1 flex justify-center items-center overflow-hidden">
        <div className="flex flex-col items-center gap-3 text-overlay">
          <span className="text-5xl opacity-50">📊</span>
          <span className="text-sm">Execute a query to see results</span>
        </div>
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex justify-between items-center px-4 py-2 bg-mantle border-b border-surface1">
          <span className="text-xs font-semibold uppercase tracking-[0.5px] text-subtext">Error</span>
        </div>
        <div className="flex-1 p-4 overflow-auto">
          <pre className="font-mono text-[13px] text-red whitespace-pre-wrap break-all">
            {result.error}
          </pre>
        </div>
      </div>
    );
  }

  const renderTable = () => (
    <div className="overflow-auto h-full">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="px-3 py-2 text-left border-b border-surface1 bg-mantle font-semibold text-subtext sticky top-0 z-10 w-[50px] text-right">
              #
            </th>
            {result.columns.map((col) => (
              <th
                key={col}
                className="px-3 py-2 text-left border-b border-surface1 bg-mantle font-semibold text-subtext sticky top-0 z-10 whitespace-nowrap"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:[&>td]:bg-surface1">
              <td className="px-3 py-2 border-b border-surface1 text-overlay w-[50px] text-right bg-mantle">
                {i + 1}
              </td>
              {result.columns.map((col) => (
                <td
                  key={col}
                  className="px-3 py-2 border-b border-surface1 text-text font-mono whitespace-nowrap"
                >
                  {formatValue(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && (
        <div className="p-10 text-center text-overlay italic">No data returned</div>
      )}
    </div>
  );

  const renderJson = () => (
    <div className="p-4 overflow-auto h-full">
      <pre className="font-mono text-[13px] leading-relaxed text-text whitespace-pre-wrap break-all">
        {JSON.stringify(result.rows, null, 2)}
      </pre>
    </div>
  );

  const renderGraph = () => (
    <div className="flex justify-center items-center h-full">
      <div className="flex flex-col items-center gap-3 text-overlay">
        <span className="text-5xl">🔜</span>
        <span className="text-sm">Graph visualization coming soon...</span>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex justify-between items-center px-4 py-2 bg-mantle border-b border-surface1">
        <div className="flex items-center gap-4">
          <span className="text-xs font-semibold uppercase tracking-[0.5px] text-subtext">Results</span>
          <span className="text-xs text-green">{result.rowCount ?? result.rows.length} rows</span>
          <span className="text-xs text-overlay">{result.executionTime.toFixed(2)}ms</span>
        </div>
        <div className="flex gap-1">
          {(
            [
              { mode: "table", label: "Table" },
              { mode: "json", label: "JSON" },
              { mode: "graph", label: "Graph" },
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={mode}
              className={`px-3 py-1 text-xs border border-transparent rounded ${
                viewMode === mode
                  ? "bg-blue text-app"
                  : "bg-transparent text-subtext hover:text-text"
              }`}
              onClick={() => setViewMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {viewMode === "table" && renderTable()}
        {viewMode === "json" && renderJson()}
        {viewMode === "graph" && renderGraph()}
      </div>
    </div>
  );
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export default ResultPanel;
