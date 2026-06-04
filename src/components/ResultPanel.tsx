import { useState } from "react";
import type { QueryResult } from "../types";
import { detectExplainMode } from "../lib/explainPlan";
import { getResultWarning } from "../lib/resultWarning";
import TableView from "./TableView";
import JsonTreeView from "./JsonTreeView";
import GraphView from "./GraphView";
import ExplainView from "./ExplainView";
import "../styles/ResultPanel.css";

interface ResultPanelProps {
  result: QueryResult | null;
}

type ViewMode = "table" | "json" | "graph" | "explain";

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function exportCsv(result: QueryResult) {
  const header = result.columns.join(",");
  const rows = result.rows.map((row) =>
    result.columns
      .map((col) => {
        const v = formatValue(row[col]);
        return v.includes(",") || v.includes('"') || v.includes("\n")
          ? `"${v.replace(/"/g, '""')}"`
          : v;
      })
      .join(","),
  );
  const csv = [header, ...rows].join("\n");
  downloadFile(csv, "result.csv", "text/csv");
}

function exportJson(result: QueryResult) {
  downloadFile(JSON.stringify(result.rows, null, 2), "result.json", "application/json");
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ResultPanel({ result }: ResultPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [jsonSearch, setJsonSearch] = useState("");
  const [lastResult, setLastResult] = useState(result);

  const explainMode = result ? detectExplainMode(result) : null;

  // When a new result arrives, default to the plan view for EXPLAIN/PROFILE,
  // otherwise the table view. Adjusting state during render (instead of in an
  // effect) is React's recommended pattern for "reset on prop change".
  if (result !== lastResult) {
    setLastResult(result);
    setViewMode(explainMode ? "explain" : "table");
  }

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

  const warning = getResultWarning(result);

  return (
    <div className="result-panel">
      <div className="result-header">
        <div className="result-info">
          <span className="result-title">Results</span>
          <span className="result-count">{result.rowCount ?? result.rows.length} rows</span>
          <span className="result-time">{result.executionTime.toFixed(2)}ms</span>
        </div>
        <div className="result-actions">
          {viewMode === "json" && (
            <input
              className="json-search-input"
              type="text"
              placeholder="Search JSON..."
              value={jsonSearch}
              onChange={(e) => setJsonSearch(e.target.value)}
              data-testid="json-search"
            />
          )}
          <button
            className="export-btn"
            onClick={() => exportCsv(result)}
            title="Export CSV"
            data-testid="export-csv"
          >
            ↓ CSV
          </button>
          <button
            className="export-btn"
            onClick={() => exportJson(result)}
            title="Export JSON"
            data-testid="export-json"
          >
            ↓ JSON
          </button>
          <div className="view-modes">
            {explainMode && (
              <button
                className={`view-mode-btn ${viewMode === "explain" ? "active" : ""}`}
                onClick={() => setViewMode("explain")}
              >
                Plan
              </button>
            )}
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
      </div>

      {warning && (
        <div
          className={`result-warning ${warning.level}`}
          role="alert"
          data-testid="result-warning"
        >
          <span className="result-warning-icon">⚠</span>
          <span className="result-warning-text">{warning.message}</span>
        </div>
      )}

      <div className="result-content">
        {viewMode === "explain" && explainMode && <ExplainView result={result} />}
        {viewMode === "table" && <TableView result={result} />}
        {viewMode === "json" && (
          <div className="json-tree-container">
            <JsonTreeView data={result.rows} search={jsonSearch} />
          </div>
        )}
        {viewMode === "graph" && <GraphView result={result} />}
      </div>
    </div>
  );
}

export default ResultPanel;
