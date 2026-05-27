import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import QueryEditor from "./components/QueryEditor";
import ResultPanel from "./components/ResultPanel";
import ConnectionModal from "./components/ConnectionModal";
import { useConnection } from "./hooks/useConnection";
import { useQueryExecution } from "./hooks/useQueryExecution";
import { normalizeError } from "./types";

/** How often to poll `GET /health` while connected. */
const HEALTH_POLL_INTERVAL_MS = 30_000;

function App() {
  const {
    isConnected,
    showConnectionModal,
    setShowConnectionModal,
    connectionConfig,
    currentSpace,
    handleConnect,
    handleDisconnect,
    handleConnectionLost,
    handleSelectSpace,
  } = useConnection();

  const { queryResult, setQueryResult, isExecuting, handleExecuteQuery } = useQueryExecution({
    isConnected,
    onConnectionLost: handleConnectionLost,
  });

  /**
   * Poll `GET /health` every 30s while connected. Crosses both hooks (resets
   * connection state and sets an error in the result panel), so it lives here.
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
          setQueryResult({
            columns: [],
            rows: [],
            executionTime: 0,
            error: "Lost connection to server. Please reconnect.",
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Health check failed:", normalizeError(error));
          handleConnectionLost("health");
          setQueryResult({
            columns: [],
            rows: [],
            executionTime: 0,
            error: "Lost connection to server. Please reconnect.",
          });
        }
      }
    };

    const id = window.setInterval(check, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isConnected, connectionConfig?.host, connectionConfig?.port]);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {showConnectionModal && (
        <ConnectionModal
          onConnect={handleConnect}
          onClose={() => isConnected && setShowConnectionModal(false)}
        />
      )}

      <div
        className="flex justify-between items-center px-5 py-3 bg-mantle border-b border-surface1 [-webkit-app-region:drag]"
      >
        <div className="flex items-center gap-2 text-base font-semibold text-text">
          <span className="text-blue text-xl">◆</span>
          ByoriDB Studio
        </div>
        <div className="flex items-center gap-2.5 text-[13px] text-subtext [-webkit-app-region:no-drag]">
          {isConnected ? (
            <>
              <span className="w-2 h-2 rounded-full bg-green shadow-[0_0_6px_#a6e3a1]" />
              <span>{connectionConfig?.host}:{connectionConfig?.port}</span>
              {currentSpace && <span className="text-sapphire font-medium">/ {currentSpace}</span>}
              <button
                className="px-3 py-1 text-xs rounded bg-transparent border border-surface1 text-subtext hover:bg-surface1 hover:border-red hover:text-red"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-overlay" />
              <span>Not connected</span>
              <button
                className="px-3 py-1 text-xs rounded bg-blue text-app hover:bg-sapphire"
                onClick={() => setShowConnectionModal(true)}
              >
                Connect
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isConnected={isConnected}
          currentSpace={currentSpace}
          onSelectSpace={handleSelectSpace}
          onExecuteQuery={handleExecuteQuery}
          onConnect={handleConnect}
        />

        <div className="flex-1 flex flex-col overflow-hidden">
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
