import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ServerSettings from "./ServerSettings";
import HistoryPanel from "./HistoryPanel";
import SavedQueriesPanel from "./SavedQueriesPanel";
import SchemaManager from "./SchemaManager";
import DataManager from "./DataManager";
import MonitorPanel from "./MonitorPanel";
import { schemaContext } from "../lib/ngql-language";
import { useTranslation } from "../hooks/useTranslation";
import type {
  ConnectionConfig,
  QueryResult,
  SpaceInfo,
  SchemaInfo,
  HistoryEntry,
  SavedQuery,
} from "../types";
import "../styles/Sidebar.css";

type TabType = "schema" | "manage" | "data" | "monitor" | "history" | "settings";

interface SidebarProps {
  isConnected: boolean;
  currentSpace: string | null;
  onSelectSpace: (spaceName: string) => void;
  onExecuteQuery: (query: string) => void;
  onConnect: (config: ConnectionConfig) => void;
  historyEntries: HistoryEntry[];
  onToggleFavorite: (id: string) => void;
  onClearHistory: () => void;
  savedQueries: SavedQuery[];
  onDeleteSavedQuery: (id: string) => void;
  connectionHost?: string;
  connectionPort?: number;
  lastQueryTime?: number;
  lastRowCount?: number;
}

/**
 * Field row shape returned by `DESCRIBE TAG` / `DESCRIBE EDGE` (byoridb
 * `byoridb-executor/src/executor.rs::schema_fields_to_result`).
 *
 * `Default` is JSON null when the field has no default.
 */
interface DescribeRow {
  Field: string;
  Type: string;
  Null: string;
  Default: unknown;
}

type DescribeState =
  | { status: "loading" }
  | { status: "ready"; rows: DescribeRow[] }
  | { status: "error"; message: string };

type DescribeKey = `tag:${string}` | `edge:${string}`;

function Sidebar({
  isConnected,
  currentSpace,
  onSelectSpace,
  onExecuteQuery,
  onConnect,
  historyEntries,
  onToggleFavorite,
  onClearHistory,
  savedQueries,
  onDeleteSavedQuery,
  connectionHost = "",
  connectionPort = 19669,
  lastQueryTime,
  lastRowCount,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<TabType>("schema");
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [schema, setSchema] = useState<SchemaInfo>({ tags: [], edges: [] });
  const [spacesError, setSpacesError] = useState("");
  const [schemaError, setSchemaError] = useState("");
  const { t } = useTranslation();
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    spaces: true,
    tags: true,
    edges: true,
  });
  const [expandedItems, setExpandedItems] = useState<Set<DescribeKey>>(new Set());
  const [describeCache, setDescribeCache] = useState<Record<DescribeKey, DescribeState>>(
    {} as Record<DescribeKey, DescribeState>,
  );

  useEffect(() => {
    if (isConnected) {
      loadSpaces();
    }
  }, [isConnected]);

  useEffect(() => {
    if (currentSpace) {
      loadSchema();
    }
  }, [currentSpace]);

  // Reset per-space caches when switching spaces — different spaces have different
  // schemas, so a `player` tag in space A is not the same object as one in space B.
  useEffect(() => {
    setExpandedItems(new Set());
    setDescribeCache({} as Record<DescribeKey, DescribeState>);
  }, [currentSpace]);

  const loadSpaces = async () => {
    try {
      const result = await invoke<SpaceInfo[]>("get_spaces");
      setSpaces(result);
      setSpacesError("");
      schemaContext.spaces = result.map((s) => s.name);
    } catch (error) {
      const msg =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setSpacesError(msg);
    }
  };

  const loadSchema = async () => {
    try {
      const result = await invoke<SchemaInfo>("get_schema");
      setSchema(result);
      setSchemaError("");
      schemaContext.tags = result.tags;
      schemaContext.edges = result.edges;
      setSchema(result);
    } catch (error) {
      const msg =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setSchemaError(msg);
    }
  };

  const describe = async (kind: "tag" | "edge", name: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    setDescribeCache((prev) => ({ ...prev, [key]: { status: "loading" } }));

    const statement = kind === "tag" ? `DESCRIBE TAG ${name}` : `DESCRIBE EDGE ${name}`;
    try {
      const result = await invoke<QueryResult>("execute_query", { query: statement });
      if (result.error) {
        setDescribeCache((prev) => ({
          ...prev,
          [key]: { status: "error", message: result.error! },
        }));
        return;
      }
      setDescribeCache((prev) => ({
        ...prev,
        [key]: { status: "ready", rows: result.rows as unknown as DescribeRow[] },
      }));
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setDescribeCache((prev) => ({
        ...prev,
        [key]: { status: "error", message },
      }));
    }
  };

  const toggleDescribe = (kind: "tag" | "edge", name: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    const nextExpanded = new Set(expandedItems);
    if (nextExpanded.has(key)) {
      nextExpanded.delete(key);
    } else {
      nextExpanded.add(key);
      if (!describeCache[key]) {
        describe(kind, name);
      }
    }
    setExpandedItems(nextExpanded);
  };

  const refreshSchema = () => {
    // Invalidate describe cache too: refreshing implies the user wants fresh data.
    setDescribeCache({} as Record<DescribeKey, DescribeState>);
    setExpandedItems(new Set());
    loadSchema();
  };

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const handleTagClick = (tagName: string) => {
    onExecuteQuery(`MATCH (v:${tagName}) RETURN v LIMIT 100`);
  };

  const handleEdgeClick = (edgeName: string) => {
    // byoridb requires the start node to have a variable (see
    // byoridb-executor/src/match.rs). End node can stay anonymous.
    onExecuteQuery(`MATCH (s)-[e:${edgeName}]->() RETURN e LIMIT 100`);
  };

  const renderDescribePanel = (kind: "tag" | "edge", name: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    const state = describeCache[key];

    if (!state || state.status === "loading") {
      return <div className="describe-panel loading">Loading schema…</div>;
    }
    if (state.status === "error") {
      return <div className="describe-panel error">Error: {state.message}</div>;
    }
    if (state.rows.length === 0) {
      return <div className="describe-panel empty">No properties.</div>;
    }

    return (
      <div className="describe-panel">
        <table className="describe-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Null</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, i) => (
              <tr key={`${row.Field}-${i}`}>
                <td>{row.Field}</td>
                <td>{row.Type}</td>
                <td>{row.Null}</td>
                <td>{row.Default === null ? "—" : String(row.Default)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderSchemaItem = (kind: "tag" | "edge", name: string, icon: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    const isOpen = expandedItems.has(key);
    const onNameClick = kind === "tag" ? () => handleTagClick(name) : () => handleEdgeClick(name);

    return (
      <div key={name} className="schema-item">
        <div className="tree-item">
          <button
            className={`expand-btn ${isOpen ? "expanded" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleDescribe(kind, name);
            }}
            aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`}
            aria-expanded={isOpen}
          >
            ▶
          </button>
          <span className="icon">{icon}</span>
          <span className="name" onClick={onNameClick}>
            {name}
          </span>
        </div>
        {isOpen && renderDescribePanel(kind, name)}
      </div>
    );
  };

  const renderSchemaContent = () => (
    <>
      <div className="sidebar-section">
        <div className="section-header" onClick={() => toggleSection("spaces")}>
          <span className={`arrow ${expandedSections.spaces ? "expanded" : ""}`}>▶</span>
          <span className="section-title">{t("schema.spaces")}</span>
          <button
            className="refresh-btn"
            onClick={(e) => {
              e.stopPropagation();
              loadSpaces();
            }}
            title="Refresh"
          >
            ↻
          </button>
        </div>
        {expandedSections.spaces && (
          <div className="section-content">
            {spacesError ? (
              <div className="error-message" title={spacesError}>
                ⚠ {spacesError}
              </div>
            ) : spaces.length === 0 ? (
              <div className="empty-message">{t("schema.noSpaces")}</div>
            ) : (
              spaces.map((space) => (
                <div
                  key={space.name}
                  className={`tree-item ${currentSpace === space.name ? "selected" : ""}`}
                  onClick={() => onSelectSpace(space.name)}
                >
                  <span className="icon">📦</span>
                  <span className="name">{space.name}</span>
                  <span className="info">P:{space.partitionNum}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {currentSpace && (
        <>
          <div className="sidebar-section">
            <div className="section-header" onClick={() => toggleSection("tags")}>
              <span className={`arrow ${expandedSections.tags ? "expanded" : ""}`}>▶</span>
              <span className="section-title">{t("schema.tags")}</span>
              <button
                className="refresh-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  refreshSchema();
                }}
                title="Refresh"
              >
                ↻
              </button>
            </div>
            {expandedSections.tags && (
              <div className="section-content">
                {schemaError ? (
                  <div className="error-message" title={schemaError}>
                    ⚠ {schemaError}
                  </div>
                ) : schema.tags.length === 0 ? (
                  <div className="empty-message">{t("schema.noTags")}</div>
                ) : (
                  schema.tags.map((tag) => renderSchemaItem("tag", tag, "🏷️"))
                )}
              </div>
            )}
          </div>

          <div className="sidebar-section">
            <div className="section-header" onClick={() => toggleSection("edges")}>
              <span className={`arrow ${expandedSections.edges ? "expanded" : ""}`}>▶</span>
              <span className="section-title">{t("schema.edges")}</span>
            </div>
            {expandedSections.edges && (
              <div className="section-content">
                {schema.edges.length === 0 ? (
                  <div className="empty-message">{t("schema.noEdges")}</div>
                ) : (
                  schema.edges.map((edge) => renderSchemaItem("edge", edge, "↔️"))
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );

  return (
    <div className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${activeTab === "schema" ? "active" : ""}`}
          onClick={() => setActiveTab("schema")}
        >
          {t("sidebar.schema")}
        </button>
        <button
          className={`sidebar-tab ${activeTab === "manage" ? "active" : ""}`}
          onClick={() => setActiveTab("manage")}
        >
          {t("sidebar.manage")}
        </button>
        <button
          className={`sidebar-tab ${activeTab === "data" ? "active" : ""}`}
          onClick={() => setActiveTab("data")}
        >
          {t("sidebar.data")}
        </button>
      </div>

      <div className="sidebar-content">
        {activeTab === "schema" && renderSchemaContent()}
        {activeTab === "manage" && (
          <SchemaManager
            spaces={spaces}
            currentSpace={currentSpace}
            schema={schema}
            onRefresh={() => {
              loadSpaces();
              if (currentSpace) loadSchema();
            }}
            onSelectSpace={onSelectSpace}
          />
        )}
        {activeTab === "data" && (
          <DataManager
            currentSpace={currentSpace}
            schema={schema}
            onExecuteQuery={onExecuteQuery}
          />
        )}
        {activeTab === "monitor" && (
          <MonitorPanel
            isConnected={isConnected}
            connectionHost={connectionHost}
            connectionPort={connectionPort}
            lastQueryTime={lastQueryTime}
            lastRowCount={lastRowCount}
          />
        )}
        {activeTab === "history" && (
          <>
            <SavedQueriesPanel
              queries={savedQueries}
              onSelect={onExecuteQuery}
              onDelete={onDeleteSavedQuery}
            />
            <HistoryPanel
              entries={historyEntries}
              onSelect={onExecuteQuery}
              onToggleFavorite={onToggleFavorite}
              onClear={onClearHistory}
            />
          </>
        )}
        {activeTab === "settings" && <ServerSettings onConnect={onConnect} />}
      </div>

      <div className="sidebar-footer">
        <button
          className={`sidebar-footer-btn ${activeTab === "monitor" ? "active" : ""}`}
          onClick={() => setActiveTab("monitor")}
          title={t("sidebar.monitor")}
          aria-label={t("sidebar.monitor")}
        >
          <span className="sidebar-footer-icon">📊</span>
          <span className="sidebar-footer-label">{t("sidebar.monitor")}</span>
        </button>
        <button
          className={`sidebar-footer-btn ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
          title={t("sidebar.history")}
          aria-label={t("sidebar.history")}
        >
          <span className="sidebar-footer-icon">🕒</span>
          <span className="sidebar-footer-label">{t("sidebar.history")}</span>
        </button>
        <button
          className={`sidebar-footer-btn ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
          title={t("sidebar.settings")}
          aria-label={t("sidebar.settings")}
        >
          <span className="sidebar-footer-icon">⚙️</span>
          <span className="sidebar-footer-label">{t("sidebar.settings")}</span>
        </button>
      </div>
    </div>
  );
}

export default Sidebar;
