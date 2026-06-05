import { useState, useEffect } from "react";
import { loadSavedConnections } from "./ServerSettings";
import { loadPassword } from "../lib/credentials";
import type { ConnectionConfig, SavedConnection } from "../types";
import { DEFAULT_CONNECTION_CONFIG } from "../types";
import "../styles/ConnectionModal.css";

interface ConnectionModalProps {
  onConnect: (config: ConnectionConfig) => void;
  onClose: () => void;
}

const DEFAULT_CONFIG = DEFAULT_CONNECTION_CONFIG;

function ConnectionModal({ onConnect, onClose }: ConnectionModalProps) {
  const [config, setConfig] = useState<ConnectionConfig>(DEFAULT_CONFIG);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    const connections = loadSavedConnections();
    setSavedConnections(connections);
    // Default to the first saved connection, pulling its password from the
    // keychain so the user can connect in one click.
    if (connections.length > 0) {
      const first = connections[0];
      loadPassword(first.config).then((password) => setConfig({ ...first.config, password }));
    }
  }, []);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      await onConnect(config);
    } catch (error) {
      console.error("Connection failed:", error);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSelectConnection = async (saved: SavedConnection) => {
    const password = await loadPassword(saved.config);
    setConfig({ ...saved.config, password });
  };

  return (
    <div className="modal-overlay">
      <div className="connection-modal">
        <div className="modal-header">
          <h2>Connect to ByoriDB</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {savedConnections.length > 0 && (
            <div className="saved-connections">
              <h3>Saved Connections</h3>
              <div className="saved-list">
                {savedConnections.map((saved) => (
                  <div
                    key={saved.name}
                    className={`saved-item ${
                      config.host === saved.config.host && config.port === saved.config.port
                        ? "selected"
                        : ""
                    }`}
                    onClick={() => handleSelectConnection(saved)}
                  >
                    <div className="saved-info">
                      <span className="saved-name">{saved.name}</span>
                      <span className="saved-details">
                        {saved.config.host}:{saved.config.port}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="form-section">
            <h3>Connection Details</h3>
            <div className="form-row">
              <label>Host</label>
              <input
                type="text"
                value={config.host}
                onChange={(e) => setConfig({ ...config, host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </div>

            <div className="form-row">
              <label>Port</label>
              <input
                type="number"
                value={config.port}
                onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 19669 })}
                placeholder="19669"
              />
            </div>

            <div className="form-row">
              <label>Protocol</label>
              <select
                value={config.protocol ?? "http"}
                onChange={(e) => {
                  const proto = e.target.value as "http" | "grpc";
                  setConfig({
                    ...config,
                    protocol: proto,
                    port: proto === "grpc" ? 9669 : 19669,
                  });
                }}
                data-testid="protocol-select"
              >
                <option value="http">HTTP REST (:19669)</option>
                <option value="grpc">gRPC (:9669)</option>
              </select>
            </div>

            <div className="form-row">
              <label>Username</label>
              <input
                type="text"
                value={config.username}
                onChange={(e) => setConfig({ ...config, username: e.target.value })}
                placeholder="root"
              />
            </div>

            <div className="form-row">
              <label>Password</label>
              <input
                type="password"
                value={config.password}
                onChange={(e) => setConfig({ ...config, password: e.target.value })}
                placeholder="Enter password"
                autoComplete="current-password"
              />
            </div>
            <p className="settings-hint" style={{ fontSize: "11px", marginTop: 4 }}>
              🔒 Saved securely in your OS keychain — never written to disk or git.
            </p>
          </div>

          <p className="settings-hint">Manage saved connections in the Settings tab.</p>
        </div>

        <div className="modal-footer">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="connect-btn" onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConnectionModal;
