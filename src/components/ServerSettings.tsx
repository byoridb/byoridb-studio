import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig, SavedConnection } from "../types";
import { DEFAULT_CONNECTION_CONFIG } from "../types";
import { setLocale, getLocale } from "../lib/i18n";
import "../styles/ServerSettings.css";

export type { ConnectionConfig, SavedConnection };

const THEME_KEY = "byoridb-studio-theme";
const FONT_SIZE_KEY = "byoridb-studio-font-size";

export function applyTheme(theme: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "");
  localStorage.setItem(THEME_KEY, theme);
}

export function applyFontSize(size: number) {
  document.documentElement.style.setProperty("--font-size-base", `${size}px`);
  localStorage.setItem(FONT_SIZE_KEY, String(size));
}

export function loadThemeSettings() {
  const theme = (localStorage.getItem(THEME_KEY) ?? "dark") as "dark" | "light";
  const fontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) ?? "14", 10);
  applyTheme(theme);
  applyFontSize(fontSize);
  return { theme, fontSize };
}

interface ServerSettingsProps {
  onConnect: (config: ConnectionConfig) => void;
}

const STORAGE_KEY = "byoridb-studio-connections";

export function loadSavedConnections(): SavedConnection[] {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return JSON.parse(saved);
  }
  return [];
}

export function saveSavedConnections(connections: SavedConnection[]): void {
  // Strip passwords before persisting — passwords are never stored on disk.
  const sanitized = connections.map((c) => ({
    ...c,
    config: { ...c.config, password: "" },
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
}

function ServerSettings({ onConnect }: ServerSettingsProps) {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [testingHost, setTestingHost] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ host: string; success: boolean } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem(THEME_KEY) ?? "dark") as "dark" | "light",
  );
  const [fontSize, setFontSize] = useState<number>(() =>
    parseInt(localStorage.getItem(FONT_SIZE_KEY) ?? "14", 10),
  );
  const [locale, setLocaleState] = useState<"en" | "ko">(() => getLocale());

  const handleLocaleChange = (l: "en" | "ko") => {
    setLocaleState(l);
    setLocale(l);
  };

  const handleThemeChange = (t: "dark" | "light") => {
    setTheme(t);
    applyTheme(t);
  };

  const handleFontSizeChange = (s: number) => {
    setFontSize(s);
    applyFontSize(s);
  };

  const [formData, setFormData] = useState<{ name: string } & ConnectionConfig>({
    name: "",
    ...DEFAULT_CONNECTION_CONFIG,
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
      updated = connections.map((c) => (c.name === editingConnection.name ? newConnection : c));
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
    setFormData({ name: "", ...DEFAULT_CONNECTION_CONFIG });
    setEditingConnection(null);
    setIsAdding(false);
  };

  const handleConnect = (config: ConnectionConfig) => {
    onConnect(config);
  };

  return (
    <div className="server-settings">
      {/* Appearance settings */}
      <div className="settings-appearance">
        <h3>Appearance</h3>
        <div className="appearance-row">
          <span className="appearance-label">Theme</span>
          <div className="theme-toggle">
            <button
              className={`theme-btn ${theme === "dark" ? "active" : ""}`}
              onClick={() => handleThemeChange("dark")}
              aria-pressed={theme === "dark"}
              data-testid="theme-dark"
            >
              🌙 Dark
            </button>
            <button
              className={`theme-btn ${theme === "light" ? "active" : ""}`}
              onClick={() => handleThemeChange("light")}
              aria-pressed={theme === "light"}
              data-testid="theme-light"
            >
              ☀️ Light
            </button>
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-label">Font size</span>
          <div className="font-size-controls">
            <button
              onClick={() => handleFontSizeChange(Math.max(10, fontSize - 1))}
              aria-label="Decrease font size"
            >
              A-
            </button>
            <span className="font-size-value" data-testid="font-size-value">
              {fontSize}px
            </span>
            <button
              onClick={() => handleFontSizeChange(Math.min(20, fontSize + 1))}
              aria-label="Increase font size"
            >
              A+
            </button>
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-label">Language</span>
          <div className="theme-toggle">
            <button
              className={`theme-btn ${locale === "en" ? "active" : ""}`}
              onClick={() => handleLocaleChange("en")}
              aria-pressed={locale === "en"}
              data-testid="lang-en"
            >
              EN
            </button>
            <button
              className={`theme-btn ${locale === "ko" ? "active" : ""}`}
              onClick={() => handleLocaleChange("ko")}
              aria-pressed={locale === "ko"}
              data-testid="lang-ko"
            >
              한국어
            </button>
          </div>
        </div>
      </div>
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
              placeholder="Enter password (not saved)"
              autoComplete="current-password"
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
                  <button className="action-btn edit" onClick={() => handleEdit(conn)} title="Edit">
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
