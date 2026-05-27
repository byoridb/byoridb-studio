import { useState, useEffect } from "react";
import { loadSavedConnections, SavedConnection, ConnectionConfig } from "./ServerSettings";

interface ConnectionModalProps {
  onConnect: (config: ConnectionConfig) => void;
  onClose: () => void;
}

const DEFAULT_CONFIG: ConnectionConfig = {
  host: "127.0.0.1",
  port: 19669,
  username: "root",
  password: "",
};

function ConnectionModal({ onConnect, onClose }: ConnectionModalProps) {
  const [config, setConfig] = useState<ConnectionConfig>(DEFAULT_CONFIG);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    const connections = loadSavedConnections();
    setSavedConnections(connections);
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

  const isSelected = (saved: SavedConnection) =>
    config.host === saved.config.host && config.port === saved.config.port;

  return (
    <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[1000]">
      <div className="w-[420px] max-w-[90%] bg-mantle rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        <div className="flex justify-between items-center px-6 py-5 border-b border-surface1">
          <h2 className="text-lg font-semibold text-text">Connect to ByoriDB</h2>
          <button
            className="w-7 h-7 p-0 text-xl bg-transparent text-overlay rounded-md flex items-center justify-center hover:bg-surface1 hover:text-text"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="p-6">
          {savedConnections.length > 0 && (
            <div className="mt-0 mb-6 pb-6 border-b border-surface1">
              <h3 className="text-xs font-semibold uppercase tracking-[0.5px] text-subtext mb-3">
                Saved Connections
              </h3>
              <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto">
                {savedConnections.map((saved) => (
                  <div
                    key={saved.name}
                    className={`flex items-center px-3 py-2.5 rounded-md cursor-pointer transition-colors duration-200 ${
                      isSelected(saved)
                        ? "bg-surface2 border border-blue"
                        : "bg-crust hover:bg-surface1"
                    }`}
                    onClick={() => handleSelectConnection(saved)}
                  >
                    <div className="flex-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-text">{saved.name}</span>
                      <span className="text-xs text-overlay">
                        {saved.config.host}:{saved.config.port}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.5px] text-subtext">
              Connection Details
            </h3>
            {(
              [
                { label: "Host", key: "host", type: "text", placeholder: "127.0.0.1" },
                { label: "Port", key: "port", type: "number", placeholder: "19669" },
                { label: "Username", key: "username", type: "text", placeholder: "root" },
                { label: "Password", key: "password", type: "password", placeholder: "Enter password" },
              ] as const
            ).map(({ label, key, type, placeholder }) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-subtext">{label}</label>
                <input
                  type={type}
                  value={String(config[key])}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      [key]: key === "port" ? parseInt(e.target.value) || 19669 : e.target.value,
                    })
                  }
                  placeholder={placeholder}
                  className="w-full"
                />
              </div>
            ))}
          </div>

          <p className="mt-4 p-2.5 text-xs text-overlay text-center bg-crust rounded-md">
            Manage saved connections in the Settings tab.
          </p>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 bg-crust border-t border-surface1">
          <button
            className="bg-transparent text-subtext border border-surface1 hover:bg-surface1 hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="bg-blue text-app font-medium min-w-[100px] hover:bg-sapphire disabled:opacity-50 disabled:cursor-not-allowed"
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
