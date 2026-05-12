import { useState, useEffect } from "react";
import { loadSavedConnections, SavedConnection, ConnectionConfig } from "./ServerSettings";
import "../styles/ConnectionModal.css";

interface ConnectionModalProps {
  onConnect: (config: ConnectionConfig) => void;
  onClose: () => void;
}

const DEFAULT_CONFIG: ConnectionConfig = {
  host: "127.0.0.1",
  port: 19669,
  username: "root",
  password: "cah",
};

function ConnectionModal({ onConnect, onClose }: ConnectionModalProps) {
  const [config, setConfig] = useState<ConnectionConfig>(DEFAULT_CONFIG);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    const connections = loadSavedConnections();
    setSavedConnections(connections);
    // If there's a saved connection, use the first one as default
    if (connections.length > 0) {
      setConfig(connections[0].config);
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

  const handleSelectConnection = (saved: SavedConnection) => {
    setConfig(saved.config);
  };

  return (
    <div className="modal-overlay">
      <div className="connection-modal">
        <div className="modal-header">
          <h2>Connect to CahGraph</h2>
          <button className="close-btn" onClick={onClose}>×</button>
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
                      config.host === saved.config.host &&
                      config.port === saved.config.port
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
              />
            </div>
          </div>

          <p className="settings-hint">
            Manage saved connections in the Settings tab.
          </p>
        </div>

        <div className="modal-footer">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="connect-btn"
            onClick={handleConnect}
            disabled={isConnecting}
          >
            {isConnecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConnectionModal;
