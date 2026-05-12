import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "../styles/ServerSettings.css";

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
      // Check for duplicate name
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
    setFormData({
      name: connection.name,
      ...connection.config,
    });
    setIsAdding(true);
  };

  const resetForm = () => {
    setFormData({ name: "", ...DEFAULT_CONFIG });
    setEditingConnection(null);
    setIsAdding(false);
  };

  const handleConnect = (config: ConnectionConfig) => {
    onConnect(config);
  };

  return (
    <div className="server-settings">
      <div className="settings-header">
        <h3>Server Connections</h3>
        {!isAdding && (
          <button className="add-btn" onClick={() => setIsAdding(true)}>
            + Add
          </button>
        )}
      </div>

      {isAdding && (
        <div className="connection-form">
          <div className="form-row">
            <label>Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="My Server"
            />
          </div>
          <div className="form-row">
            <label>Host</label>
            <input
              type="text"
              value={formData.host}
              onChange={(e) => setFormData({ ...formData, host: e.target.value })}
              placeholder="127.0.0.1"
            />
          </div>
          <div className="form-row">
            <label>Port</label>
            <input
              type="number"
              value={formData.port}
              onChange={(e) =>
                setFormData({ ...formData, port: parseInt(e.target.value) || 19669 })
              }
              placeholder="19669"
            />
          </div>
          <div className="form-row">
            <label>Username</label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              placeholder="root"
            />
          </div>
          <div className="form-row">
            <label>Password</label>
            <input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              placeholder="Enter password"
            />
          </div>
          <div className="form-actions">
            <button className="cancel-btn" onClick={resetForm}>
              Cancel
            </button>
            <button
              className="test-btn"
              onClick={() => handleTest(formData)}
              disabled={testingHost === `${formData.host}:${formData.port}`}
            >
              {testingHost === `${formData.host}:${formData.port}` ? "Testing..." : "Test"}
            </button>
            <button className="save-btn" onClick={handleSave}>
              {editingConnection ? "Update" : "Save"}
            </button>
          </div>
          {testResult && testResult.host === `${formData.host}:${formData.port}` && (
            <div className={`test-result ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? "Connection successful!" : "Connection failed"}
            </div>
          )}
        </div>
      )}

      <div className="connections-list">
        {connections.length === 0 ? (
          <div className="empty-message">No saved connections</div>
        ) : (
          connections.map((conn) => {
            const hostKey = `${conn.config.host}:${conn.config.port}`;
            return (
              <div key={conn.name} className="connection-item">
                <div className="connection-info">
                  <span className="connection-name">{conn.name}</span>
                  <span className="connection-details">
                    {conn.config.host}:{conn.config.port} ({conn.config.username})
                  </span>
                </div>
                <div className="connection-actions">
                  <button
                    className="action-btn test"
                    onClick={() => handleTest(conn.config)}
                    disabled={testingHost === hostKey}
                    title="Test connection"
                  >
                    {testingHost === hostKey ? "..." : "Test"}
                  </button>
                  <button
                    className="action-btn edit"
                    onClick={() => handleEdit(conn)}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className="action-btn delete"
                    onClick={() => handleDelete(conn.name)}
                    title="Delete"
                  >
                    ×
                  </button>
                  <button
                    className="action-btn connect"
                    onClick={() => handleConnect(conn.config)}
                    title="Connect"
                  >
                    Connect
                  </button>
                </div>
                {testResult && testResult.host === hostKey && (
                  <div className={`test-result ${testResult.success ? "success" : "error"}`}>
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
