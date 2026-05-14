import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import QueryEditor from "./components/QueryEditor";
import ResultPanel from "./components/ResultPanel";
import ConnectionModal from "./components/ConnectionModal";
import type { ConnectionConfig, QueryResult, TauriError } from "./types";
import "./styles/App.css";

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

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [showConnectionModal, setShowConnectionModal] = useState(true);
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig | null>(null);
  const [currentSpace, setCurrentSpace] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

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
   * Poll `GET /health` (via the backend `test_connection` command) every
   * 30s while connected. Surface a lost connection to the UI as soon as
   * the check fails. The check itself is independent of any in-flight
   * query, so a long query won't be interrupted.
   */
  useEffect(() => {
    if (!isConnected || !connectionConfig) return undefined;

    let cancelled = false;

    const check = async () => {
      try {
        const ok = await invoke<boolean>("test_connection", {
          host: connectionConfig.host,
          port: connectionConfig.port,
        });
        if (!ok && !cancelled) {
          handleConnectionLost("health");
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Health check failed:", normalizeError(error));
          handleConnectionLost("health");
        }
      }
    };

    const id = window.setInterval(check, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isConnected, connectionConfig?.host, connectionConfig?.port]);

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
      alert(`Connection failed: ${e.message}${hint}`);
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

  const handleExecuteQuery = async (query: string) => {
    if (!isConnected) {
      alert("Not connected to server");
      return;
    }

    setIsExecuting(true);
    try {
      const startTime = performance.now();
      const result = await invoke<QueryResult>("execute_query", { query });
      const endTime = performance.now();

      setQueryResult({
        ...result,
        executionTime: endTime - startTime,
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
      alert(`Failed to switch to space "${spaceName}": ${e.message}`);
    }
  };

  return (
    <div className="app">
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
              <button className="btn-disconnect" onClick={handleDisconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span className="status-indicator disconnected" />
              <span>Not connected</span>
              <button className="btn-connect" onClick={() => setShowConnectionModal(true)}>
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
        />

        <div className="main-content">
          <QueryEditor
            onExecute={handleExecuteQuery}
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
