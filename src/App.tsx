import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import QueryEditor from "./components/QueryEditor";
import ResultPanel from "./components/ResultPanel";
import ConnectionModal from "./components/ConnectionModal";
import { loadThemeSettings } from "./components/ServerSettings";
import { useToast, ToastContainer } from "./hooks/useToast";
import type { ConnectionConfig, QueryResult, TauriError, HistoryEntry } from "./types";
import { HISTORY_STORAGE_KEY } from "./types";
import "./styles/App.css";

// Apply saved theme/font on startup
loadThemeSettings();

/**
 * Normalize anything thrown from an `invoke` call into `{code, message}`.
 *
 * Tauri commands return a serialized `TauriError` object on `Err(_)`, but
 * defensive coding: network/marshaling failures may still throw a bare
 * string or Error.
 */
function normalizeError(err: unknown): TauriError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as TauriError;
  }
  return { code: "UNKNOWN", message: String(err) };
}

/** How often to poll `GET /health` while connected. */
const HEALTH_POLL_INTERVAL_MS = 30_000;
/** Backoff: max retries before giving up and disconnecting. */
const HEALTH_MAX_RETRIES = 3;
/** Backoff base delay in ms (doubles each retry: 2s, 4s, 8s). */
const HEALTH_BACKOFF_BASE_MS = 2_000;

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [showConnectionModal, setShowConnectionModal] = useState(true);
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig | null>(null);
  const { toasts, addToast, removeToast } = useToast();
  const [currentSpace, setCurrentSpace] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>(() => {
    try {
      const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as HistoryEntry[]) : [];
    } catch {
      return [];
    }
  });

  const addHistoryEntry = useCallback((entry: HistoryEntry) => {
    setHistoryEntries((prev) => {
      // Deduplicate by query text, keep newest
      const next = [entry, ...prev.filter((e) => e.query !== entry.query)].slice(0, 200);
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setHistoryEntries((prev) => {
      const next = prev.map((e) => (e.id === id ? { ...e, favorite: !e.favorite } : e));
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistoryEntries([]);
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  }, []);

  /** Called when we detect the server session or reachability is gone. */
  const handleConnectionLost = (reason: "session" | "health") => {
    setIsConnected(false);
    setConnectionConfig(null);
    setCurrentSpace(null);
    setShowConnectionModal(true);
    if (reason === "health") {
      setQueryResult({
        columns: [],
        rows: [],
        executionTime: 0,
        error: "Lost connection to server. Please reconnect.",
      });
    }
  };

  /**
   * Poll `GET /health` every 30s while connected.
   * On failure, retry up to HEALTH_MAX_RETRIES times with exponential backoff
   * (2s, 4s, 8s) before giving up and disconnecting.
   */
  useEffect(() => {
    if (!isConnected || !connectionConfig) return undefined;

    let cancelled = false;

    const attemptReconnect = async (host: string, port: number): Promise<boolean> => {
      for (let i = 0; i < HEALTH_MAX_RETRIES; i++) {
        if (cancelled) return false;
        const delay = HEALTH_BACKOFF_BASE_MS * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return false;
        try {
          const ok = await invoke<boolean>("test_connection", { host, port });
          if (ok) return true;
        } catch {
          // continue retrying
        }
      }
      return false;
    };

    const check = async () => {
      if (cancelled) return;
      try {
        const ok = await invoke<boolean>("test_connection", {
          host: connectionConfig.host,
          port: connectionConfig.port,
        });
        if (ok) {
          return;
        }
      } catch {
        // fall through to retry logic
      }

      if (cancelled) return;

      // Try to reconnect with backoff before giving up
      const recovered = await attemptReconnect(connectionConfig.host, connectionConfig.port);
      if (!cancelled && !recovered) {
        handleConnectionLost("health");
      }
    };

    const id = window.setInterval(check, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isConnected, connectionConfig]);

  const handleConnect = async (config: ConnectionConfig) => {
    try {
      await invoke("connect", { config });
      setConnectionConfig(config);
      setIsConnected(true);
      setShowConnectionModal(false);
    } catch (error) {
      const e = normalizeError(error);
      console.error("Connection failed:", e);
      const hint =
        e.code === "AUTH_FAILED"
          ? "\n\nHint: the ByoriDB server reads the root password from the BYORIDB_ROOT_PASSWORD env var. If unset, the server generates a random one at startup and logs it."
          : "";
      addToast(`Connection failed: ${e.message}${hint}`, "error");
    }
  };

  const handleDisconnect = async () => {
    try {
      await invoke("disconnect");
      setIsConnected(false);
      setConnectionConfig(null);
      setCurrentSpace(null);
      setQueryResult(null);
      setShowConnectionModal(true);
    } catch (error) {
      const e = normalizeError(error);
      console.error("Disconnect failed:", e);
    }
  };

  const handleCancelQuery = useCallback(async () => {
    try {
      await invoke("cancel_query");
    } catch {
      // ignore
    }
  }, []);

  const handleExecuteQuery = async (query: string) => {
    if (!isConnected) {
      addToast("Not connected to server", "error");
      return;
    }

    setIsExecuting(true);
    try {
      const startTime = performance.now();
      const result = await invoke<QueryResult>("execute_query", { query });
      const endTime = performance.now();
      const executionTime = endTime - startTime;

      setQueryResult({ ...result, executionTime });
      addHistoryEntry({
        id: `h-${Date.now()}`,
        query,
        executedAt: Date.now(),
        executionTime,
        rowCount: result.rowCount ?? result.rows.length,
        favorite: false,
      });
    } catch (error) {
      const e = normalizeError(error);

      if (e.code === "SESSION_EXPIRED") {
        setQueryResult({
          columns: [],
          rows: [],
          executionTime: 0,
          error: "Session expired. Please reconnect.",
        });
        handleConnectionLost("session");
        return;
      }

      setQueryResult({
        columns: [],
        rows: [],
        executionTime: 0,
        error: e.message,
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleSelectSpace = async (spaceName: string) => {
    // Side-effect only: don't pipe USE results through handleExecuteQuery
    // (which would overwrite the result panel with an empty/dummy response)
    // and don't flip currentSpace if the switch failed.
    try {
      await invoke<QueryResult>("execute_query", {
        query: `USE ${spaceName}`,
      });
      setCurrentSpace(spaceName);
    } catch (error) {
      const e = normalizeError(error);
      console.error("Failed to select space:", e);
      if (e.code === "SESSION_EXPIRED") {
        handleConnectionLost("session");
        return;
      }
      addToast(`Failed to switch to space "${spaceName}": ${e.message}`, "error");
    }
  };

  return (
    <div className="app">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {showConnectionModal && (
        <ConnectionModal
          onConnect={handleConnect}
          onClose={() => isConnected && setShowConnectionModal(false)}
        />
      )}

      <div className="app-header">
        <div className="app-title">
          <span className="logo">◆</span>
          ByoriDB Studio
        </div>
        <div className="connection-status">
          {isConnected ? (
            <>
              <span className="status-indicator connected" />
              <span>
                {connectionConfig?.host}:{connectionConfig?.port}
              </span>
              {currentSpace && <span className="current-space">/ {currentSpace}</span>}
              <button
                className="btn-disconnect"
                onClick={handleDisconnect}
                aria-label="Disconnect from server"
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span className="status-indicator disconnected" aria-hidden="true" />
              <span>Not connected</span>
              <button
                className="btn-connect"
                onClick={() => setShowConnectionModal(true)}
                aria-label="Open connection dialog"
              >
                Connect
              </button>
            </>
          )}
        </div>
      </div>

      <div className="app-body">
        <Sidebar
          isConnected={isConnected}
          currentSpace={currentSpace}
          onSelectSpace={handleSelectSpace}
          onExecuteQuery={handleExecuteQuery}
          onConnect={handleConnect}
          historyEntries={historyEntries}
          onToggleFavorite={toggleFavorite}
          onClearHistory={clearHistory}
          connectionHost={connectionConfig?.host}
          connectionPort={connectionConfig?.port}
          lastQueryTime={queryResult?.executionTime}
          lastRowCount={queryResult?.rowCount ?? queryResult?.rows.length}
        />

        <div className="main-content">
          <QueryEditor
            onExecute={handleExecuteQuery}
            onCancel={handleCancelQuery}
            isExecuting={isExecuting}
            isConnected={isConnected}
          />
          <ResultPanel result={queryResult} />
        </div>
      </div>
    </div>
  );
}

export default App;
