import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../types";
import "../styles/MonitorPanel.css";

interface MonitorPanelProps {
  isConnected: boolean;
  connectionHost: string;
  connectionPort: number;
  lastQueryTime?: number; // ms
  lastRowCount?: number;
}

interface MetricLine {
  name: string;
  value: string;
  help?: string;
}

function parsePrometheus(text: string): MetricLine[] {
  const lines = text.split("\n");
  const result: MetricLine[] = [];
  let lastHelp = "";
  for (const line of lines) {
    if (line.startsWith("# HELP")) {
      lastHelp = line.replace(/^# HELP \S+ /, "");
    } else if (!line.startsWith("#") && line.trim()) {
      const spaceIdx = line.lastIndexOf(" ");
      if (spaceIdx === -1) continue;
      const name = line.slice(0, spaceIdx);
      const value = line.slice(spaceIdx + 1);
      result.push({ name, value, help: lastHelp });
      lastHelp = "";
    }
  }
  return result;
}

function MonitorPanel({
  isConnected,
  connectionHost,
  connectionPort,
  lastQueryTime,
  lastRowCount,
}: MonitorPanelProps) {
  const [serverVersion, setServerVersion] = useState<string>("");
  const [metrics, setMetrics] = useState<MetricLine[]>([]);
  const [metricsError, setMetricsError] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchVersion = useCallback(async () => {
    if (!isConnected) return;
    try {
      const result = await invoke<QueryResult>("execute_query", { query: "SHOW HOSTS" });
      const row = result.rows[0];
      if (row) {
        const ver = row["Version"] ?? row["version"] ?? "";
        setServerVersion(String(ver));
      }
    } catch {
      // ignore
    }
  }, [isConnected]);

  const fetchMetrics = useCallback(async () => {
    if (!isConnected || !connectionHost || !connectionPort) return;
    setLoading(true);
    setMetricsError("");
    try {
      // Cross-origin fetch from Tauri WebView is blocked ("TypeError: Load failed"
      // on macOS WKWebView). Proxy via Rust backend.
      const text = await invoke<string>("fetch_metrics", {
        host: connectionHost,
        port: connectionPort,
      });
      setMetrics(parsePrometheus(text).slice(0, 50));
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setMetricsError(msg);
      setMetrics([]);
    } finally {
      setLoading(false);
    }
  }, [isConnected, connectionHost, connectionPort]);

  useEffect(() => {
    if (isConnected) {
      fetchVersion();
    } else {
      setServerVersion("");
      setMetrics([]);
    }
  }, [isConnected, fetchVersion]);

  if (!isConnected) {
    return (
      <div className="monitor-panel">
        <p className="monitor-hint">Connect to a server to view monitoring data.</p>
      </div>
    );
  }

  return (
    <div className="monitor-panel">
      <div className="monitor-section">
        <h4>Server Info</h4>
        <div className="monitor-row">
          <span className="monitor-label">Host</span>
          <span className="monitor-value">
            {connectionHost}:{connectionPort}
          </span>
        </div>
        {serverVersion && (
          <div className="monitor-row">
            <span className="monitor-label">Version</span>
            <span className="monitor-value">{serverVersion}</span>
          </div>
        )}
      </div>

      <div className="monitor-section">
        <h4>Last Query</h4>
        {lastQueryTime !== undefined ? (
          <>
            <div className="monitor-row">
              <span className="monitor-label">Time</span>
              <span className={`monitor-value ${lastQueryTime > 1000 ? "slow" : ""}`}>
                {lastQueryTime.toFixed(2)}ms
                {lastQueryTime > 1000 && " ⚠ slow"}
              </span>
            </div>
            {lastRowCount !== undefined && (
              <div className="monitor-row">
                <span className="monitor-label">Rows</span>
                <span className="monitor-value">{lastRowCount}</span>
              </div>
            )}
          </>
        ) : (
          <p className="monitor-hint">No query executed yet.</p>
        )}
      </div>

      <div className="monitor-section">
        <div className="monitor-section-header">
          <h4>Metrics</h4>
          <button className="monitor-refresh-btn" onClick={fetchMetrics} disabled={loading}>
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
        {metricsError && <p className="monitor-error">{metricsError}</p>}
        {metrics.length > 0 && (
          <div className="monitor-metrics">
            {metrics.map((m, i) => (
              <div key={i} className="monitor-metric-row" title={m.help}>
                <span className="monitor-metric-name">{m.name}</span>
                <span className="monitor-metric-value">{m.value}</span>
              </div>
            ))}
          </div>
        )}
        {metrics.length === 0 && !metricsError && !loading && (
          <p className="monitor-hint">Click Refresh to load metrics.</p>
        )}
      </div>
    </div>
  );
}

export default MonitorPanel;
