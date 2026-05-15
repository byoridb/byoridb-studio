import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ServerSettings from "./ServerSettings";
import HistoryPanel from "./HistoryPanel";
import type { ConnectionConfig, QueryResult, SpaceInfo, SchemaInfo, HistoryEntry } from "../types";
import "../styles/Sidebar.css";

type TabType = "schema" | "history" | "settings";

interface SidebarProps {
  isConnected: boolean;
  currentSpace: string | null;
  onSelectSpace: (spaceName: string) => void;
  onExecuteQuery: (query: string) => void;
  onConnect: (config: ConnectionConfig) => void;
  historyEntries: HistoryEntry[];
  onToggleFavorite: (id: string) => void;
  onClearHistory: () => void;
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
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<TabType>("schema");
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [schema, setSchema] = useState<SchemaInfo>({ tags: [], edges: [] });
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
    } catch (error) {
      console.error("Failed to load spaces:", error);
    }
  };

  const loadSchema = async () => {
    try {
      const result = await invoke<SchemaInfo>("get_schema");
      setSchema(result);
    } catch (error) {
      console.error("Failed to load schema:", error);
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
          <span className="section-title">Spaces</span>
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
            {spaces.length === 0 ? (
              <div className="empty-message">No spaces found</div>
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
              <span className="section-title">Tags</span>
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
                {schema.tags.length === 0 ? (
                  <div className="empty-message">No tags found</div>
                ) : (
                  schema.tags.map((tag) => renderSchemaItem("tag", tag, "🏷️"))
                )}
              </div>
            )}
          </div>

          <div className="sidebar-section">
            <div className="section-header" onClick={() => toggleSection("edges")}>
              <span className={`arrow ${expandedSections.edges ? "expanded" : ""}`}>▶</span>
              <span className="section-title">Edges</span>
            </div>
            {expandedSections.edges && (
              <div className="section-content">
                {schema.edges.length === 0 ? (
                  <div className="empty-message">No edges found</div>
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
          Schema
        </button>
        <button
          className={`sidebar-tab ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
        <button
          className={`sidebar-tab ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
      </div>

      <div className="sidebar-content">
        {activeTab === "schema" && renderSchemaContent()}
        {activeTab === "history" && (
          <HistoryPanel
            entries={historyEntries}
            onSelect={onExecuteQuery}
            onToggleFavorite={onToggleFavorite}
            onClear={onClearHistory}
          />
        )}
        {activeTab === "settings" && <ServerSettings onConnect={onConnect} />}
      </div>
    </div>
  );
}

export default Sidebar;
