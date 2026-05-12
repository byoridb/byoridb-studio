import { useState } from "react";
import "../styles/ResultPanel.css";

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime: number;
  /** Server-reported row count (cah-graph `QueryResponse.row_count`); falls back to `rows.length` if absent. */
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
      <div className="result-panel empty">
        <div className="empty-state">
          <span className="empty-icon">📊</span>
          <span className="empty-text">Execute a query to see results</span>
        </div>
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="result-panel error">
        <div className="result-header">
          <span className="result-title">Error</span>
        </div>
        <div className="error-content">
          <pre>{result.error}</pre>
        </div>
      </div>
    );
  }

  const renderTable = () => (
    <div className="table-container">
      <table className="result-table">
        <thead>
          <tr>
            <th className="row-number">#</th>
            {result.columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              <td className="row-number">{i + 1}</td>
              {result.columns.map((col) => (
                <td key={col}>
                  {formatValue(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && (
        <div className="no-data">No data returned</div>
      )}
    </div>
  );

  const renderJson = () => (
    <div className="json-container">
      <pre>{JSON.stringify(result.rows, null, 2)}</pre>
    </div>
  );

  const renderGraph = () => (
    <div className="graph-container">
      <div className="graph-placeholder">
        <span className="placeholder-icon">🔜</span>
        <span className="placeholder-text">Graph visualization coming soon...</span>
      </div>
    </div>
  );

  return (
    <div className="result-panel">
      <div className="result-header">
        <div className="result-info">
          <span className="result-title">Results</span>
          <span className="result-count">{result.rowCount ?? result.rows.length} rows</span>
          <span className="result-time">{result.executionTime.toFixed(2)}ms</span>
        </div>
        <div className="view-modes">
          <button
            className={`view-mode-btn ${viewMode === "table" ? "active" : ""}`}
            onClick={() => setViewMode("table")}
          >
            Table
          </button>
          <button
            className={`view-mode-btn ${viewMode === "json" ? "active" : ""}`}
            onClick={() => setViewMode("json")}
          >
            JSON
          </button>
          <button
            className={`view-mode-btn ${viewMode === "graph" ? "active" : ""}`}
            onClick={() => setViewMode("graph")}
          >
            Graph
          </button>
        </div>
      </div>

      <div className="result-content">
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
