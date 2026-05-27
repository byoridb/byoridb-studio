import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SavedConnection {
  name: string;
  config: ConnectionConfig;
}

interface ServerSettingsProps {
  onConnect: (config: ConnectionConfig) => void;
}

const DEFAULT_CONFIG: ConnectionConfig = {
  host: "127.0.0.1",
  port: 19669,
  username: "root",
  password: "",
};

const STORAGE_KEY = "byoridb-studio-connections";

export function loadSavedConnections(): SavedConnection[] {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return JSON.parse(saved);
  }
  return [];
}

export function saveSavedConnections(connections: SavedConnection[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
}

function ServerSettings({ onConnect }: ServerSettingsProps) {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [testingHost, setTestingHost] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ host: string; success: boolean } | null>(null);

  const [formData, setFormData] = useState<{ name: string } & ConnectionConfig>({
    name: "",
    ...DEFAULT_CONFIG,
  });

  useEffect(() => {
    setConnections(loadSavedConnections());
  }, []);

  const handleTest = async (config: ConnectionConfig) => {
    const hostKey = `${config.host}:${config.port}`;
    setTestingHost(hostKey);
    setTestResult(null);

    try {
      const result = await invoke<boolean>("test_connection", {
        host: config.host,
        port: config.port,
      });
      setTestResult({ host: hostKey, success: result });
    } catch {
      setTestResult({ host: hostKey, success: false });
    } finally {
      setTestingHost(null);
    }
  };

  const handleSave = () => {
    if (!formData.name.trim()) {
      alert("Please enter a connection name");
      return;
    }

    const newConnection: SavedConnection = {
      name: formData.name,
      config: {
        host: formData.host,
        port: formData.port,
        username: formData.username,
        password: formData.password,
      },
    };

    let updated: SavedConnection[];
    if (editingConnection) {
      updated = connections.map((c) =>
        c.name === editingConnection.name ? newConnection : c
      );
    } else {
      if (connections.some((c) => c.name === formData.name)) {
        alert("A connection with this name already exists");
        return;
      }
      updated = [...connections, newConnection];
    }

    setConnections(updated);
    saveSavedConnections(updated);
    resetForm();
  };

  const handleDelete = (name: string) => {
    if (confirm(`Delete connection "${name}"?`)) {
      const updated = connections.filter((c) => c.name !== name);
      setConnections(updated);
      saveSavedConnections(updated);
    }
  };

  const handleEdit = (connection: SavedConnection) => {
    setEditingConnection(connection);
    setFormData({ name: connection.name, ...connection.config });
    setIsAdding(true);
  };

  const resetForm = () => {
    setFormData({ name: "", ...DEFAULT_CONFIG });
    setEditingConnection(null);
    setIsAdding(false);
  };

  const formHostKey = `${formData.host}:${formData.port}`;

  return (
    <div className="p-3">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.5px] text-subtext m-0">
          Server Connections
        </h3>
        {!isAdding && (
          <button
            className="px-3 py-1 text-xs bg-blue text-app rounded font-medium hover:bg-sapphire"
            onClick={() => setIsAdding(true)}
          >
            + Add
          </button>
        )}
      </div>

      {isAdding && (
        <div className="bg-crust rounded-lg p-4 mb-4">
          {(
            [
              { label: "Name", key: "name", type: "text", placeholder: "My Server" },
              { label: "Host", key: "host", type: "text", placeholder: "127.0.0.1" },
              { label: "Port", key: "port", type: "number", placeholder: "19669" },
              { label: "Username", key: "username", type: "text", placeholder: "root" },
              { label: "Password", key: "password", type: "password", placeholder: "Enter password" },
            ] as const
          ).map(({ label, key, type, placeholder }) => (
            <div key={key} className="flex flex-col gap-1 mb-3 last:mb-0">
              <label className="text-[11px] font-medium text-subtext">{label}</label>
              <input
                type={type}
                value={String(formData[key])}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    [key]: key === "port" ? parseInt(e.target.value) || 19669 : e.target.value,
                  })
                }
                placeholder={placeholder}
                className="w-full py-2 px-2.5 text-[13px] bg-mantle border border-surface1 rounded text-text focus:border-blue outline-none"
              />
            </div>
          ))}

          <div className="flex gap-2 mt-4">
            <button
              className="px-3 py-1.5 text-xs bg-transparent text-subtext border border-surface1 rounded hover:bg-surface1 hover:text-text"
              onClick={resetForm}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1.5 text-xs bg-mantle text-subtext border border-surface1 rounded hover:bg-surface1 hover:text-text disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => handleTest(formData)}
              disabled={testingHost === formHostKey}
            >
              {testingHost === formHostKey ? "Testing..." : "Test"}
            </button>
            <button
              className="px-3 py-1.5 text-xs bg-blue text-app rounded font-medium hover:bg-sapphire ml-auto"
              onClick={handleSave}
            >
              {editingConnection ? "Update" : "Save"}
            </button>
          </div>

          {testResult && testResult.host === formHostKey && (
            <div
              className={`mt-2 px-2.5 py-1.5 text-xs rounded text-center ${
                testResult.success
                  ? "bg-green/15 text-green"
                  : "bg-red/15 text-red"
              }`}
            >
              {testResult.success ? "Connection successful!" : "Connection failed"}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {connections.length === 0 ? (
          <div className="p-4 text-xs text-overlay italic text-center">No saved connections</div>
        ) : (
          connections.map((conn) => {
            const hostKey = `${conn.config.host}:${conn.config.port}`;
            return (
              <div key={conn.name} className="bg-crust rounded-md p-3 relative">
                <div className="flex flex-col gap-1 mb-2.5">
                  <span className="text-sm font-medium text-text">{conn.name}</span>
                  <span className="text-xs text-overlay">
                    {conn.config.host}:{conn.config.port} ({conn.config.username})
                  </span>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    className="px-2.5 py-1 text-[11px] font-medium rounded bg-mantle text-subtext border border-surface1 hover:bg-surface1 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => handleTest(conn.config)}
                    disabled={testingHost === hostKey}
                    title="Test connection"
                  >
                    {testingHost === hostKey ? "..." : "Test"}
                  </button>
                  <button
                    className="px-2.5 py-1 text-[11px] font-medium rounded bg-mantle text-subtext border border-surface1 hover:bg-surface1"
                    onClick={() => handleEdit(conn)}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className="px-2 py-1 text-sm font-medium rounded bg-transparent text-overlay border border-transparent hover:bg-red hover:text-app"
                    onClick={() => handleDelete(conn.name)}
                    title="Delete"
                  >
                    ×
                  </button>
                  <button
                    className="px-2.5 py-1 text-[11px] font-medium rounded bg-blue text-app hover:bg-sapphire ml-auto"
                    onClick={() => onConnect(conn.config)}
                    title="Connect"
                  >
                    Connect
                  </button>
                </div>
                {testResult && testResult.host === hostKey && (
                  <div
                    className={`mt-2.5 px-2 py-1 text-[11px] rounded text-center ${
                      testResult.success
                        ? "bg-green/15 text-green"
                        : "bg-red/15 text-red"
                    }`}
                  >
                    {testResult.success ? "OK" : "Failed"}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ServerSettings;
