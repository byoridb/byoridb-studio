import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig } from "../components/ServerSettings";
import { upsertConnection } from "../components/ServerSettings";
import { savePassword } from "../lib/credentials";
import { normalizeError } from "../types";

export function useConnection() {
  const [isConnected, setIsConnected] = useState(false);
  const [showConnectionModal, setShowConnectionModal] = useState(true);
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig | null>(null);
  const [currentSpace, setCurrentSpace] = useState<string | null>(null);

  const handleConnectionLost = useCallback((reason: "session" | "health") => {
    void reason;
    setIsConnected(false);
    setConnectionConfig(null);
    setCurrentSpace(null);
    setShowConnectionModal(true);
  }, []);

  const handleConnect = async (config: ConnectionConfig) => {
    try {
      await invoke("connect", { config });
      setConnectionConfig(config);
      setIsConnected(true);
      setShowConnectionModal(false);
      // Auto-remember the server (metadata in localStorage, password in the OS
      // keychain). Best-effort: never blocks or fails the connection.
      try {
        upsertConnection(config);
        void savePassword(config);
      } catch (e) {
        console.warn("Failed to remember connection:", e);
      }
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
      setShowConnectionModal(true);
    } catch (error) {
      const e = normalizeError(error);
      console.error("Disconnect failed:", e);
    }
  };

  const handleSelectSpace = async (spaceName: string) => {
    try {
      await invoke<void>("execute_query", { query: `USE ${spaceName}` });
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

  return {
    isConnected,
    showConnectionModal,
    setShowConnectionModal,
    connectionConfig,
    currentSpace,
    handleConnect,
    handleDisconnect,
    handleConnectionLost,
    handleSelectSpace,
  };
}
