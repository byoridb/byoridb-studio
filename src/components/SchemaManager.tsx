import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SpaceInfo, SchemaInfo, QueryResult } from "../types";
import ErdDiagram from "./ErdDiagram";
import { ConfirmDialog } from "../hooks/useToast";
import "../styles/SchemaManager.css";

interface SchemaManagerProps {
  spaces: SpaceInfo[];
  currentSpace: string | null;
  schema: SchemaInfo;
  onRefresh: () => void;
  onSelectSpace: (name: string) => void;
}

interface TagEdgeField {
  name: string;
  type: string;
  nullable: boolean;
}

interface DescribeRow {
  Field: string;
  Type: string;
  Null: string;
  Default: string | null;
}

interface StatRow {
  Type: string;
  Name: string;
  Count: number;
}

interface IndexRow {
  "Index Name": string;
  "On Tag"?: string;
  "On Edge"?: string;
  Fields: string;
}

const FIELD_TYPES = ["STRING", "INT64", "INT32", "FLOAT", "DOUBLE", "BOOL", "TIMESTAMP", "DATE"];
const TABS = ["spaces", "tags", "edges", "indexes", "statistics", "erd"] as const;
type Tab = (typeof TABS)[number];

function FieldEditor({
  fields,
  onChange,
}: {
  fields: TagEdgeField[];
  onChange: (f: TagEdgeField[]) => void;
}) {
  const add = () => onChange([...fields, { name: "", type: "STRING", nullable: true }]);
  const remove = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<TagEdgeField>) =>
    onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div className="field-editor">
      {fields.map((f, i) => (
        <div key={i} className="field-row">
          <input
            placeholder="field name"
            value={f.name}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <select value={f.type} onChange={(e) => update(i, { type: e.target.value })}>
            {FIELD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <label className="field-null">
            <input
              type="checkbox"
              checked={f.nullable}
              onChange={(e) => update(i, { nullable: e.target.checked })}
            />
            NULL
          </label>
          <button className="field-remove" onClick={() => remove(i)}>
            ×
          </button>
        </div>
      ))}
      <button className="field-add" onClick={add}>
        + Add field
      </button>
    </div>
  );
}

function buildFieldsDDL(fields: TagEdgeField[]): string {
  return fields
    .filter((f) => f.name.trim())
    .map((f) => `${f.name} ${f.type}${f.nullable ? "" : " NOT NULL"}`)
    .join(", ");
}

function SchemaManager({
  spaces,
  currentSpace,
  schema,
  onRefresh,
  onSelectSpace,
}: SchemaManagerProps) {
  const [tab, setTab] = useState<Tab>("spaces");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmMsg, setConfirmMsg] = useState<{ msg: string; action: () => void } | null>(null);

  // spaces form
  const [newSpaceName, setNewSpaceName] = useState("");
  const [vidType, setVidType] = useState("INT64");

  // tags/edges form
  const [newName, setNewName] = useState("");
  const [fields, setFields] = useState<TagEdgeField[]>([]);
  const [searchFilter, setSearchFilter] = useState("");
  const [expandedItems, setExpandedItems] = useState<Record<string, DescribeRow[]>>({});
  const [loadingDescribe, setLoadingDescribe] = useState<Record<string, boolean>>({});

  // indexes state
  const [indexKind, setIndexKind] = useState<"tag" | "edge">("tag");
  const [indexName, setIndexName] = useState("");
  const [indexOn, setIndexOn] = useState("");
  const [tagIndexes, setTagIndexes] = useState<IndexRow[]>([]);
  const [edgeIndexes, setEdgeIndexes] = useState<IndexRow[]>([]);
  const [indexViewKind, setIndexViewKind] = useState<"tag" | "edge">("tag");
  const [indexesLoading, setIndexesLoading] = useState(false);

  // statistics state
  const [stats, setStats] = useState<StatRow[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsTime, setStatsTime] = useState("");

  const run = useCallback(
    async (stmt: string) => {
      setError("");
      setSuccess("");
      try {
        await invoke("execute_statement", { statement: stmt });
        setSuccess(`✓ Done: ${stmt.split(" ").slice(0, 3).join(" ")}`);
        onRefresh();
      } catch (e: unknown) {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setError(msg);
      }
    },
    [onRefresh],
  );

  const runQuery = useCallback(async (query: string): Promise<QueryResult | null> => {
    try {
      return await invoke<QueryResult>("execute_query", { query });
    } catch {
      return null;
    }
  }, []);

  // --- Statistics ---
  const loadStats = useCallback(async () => {
    if (!currentSpace) return;
    setStatsLoading(true);
    const result = await runQuery("SHOW STATS");
    if (result) {
      setStats(result.rows as unknown as StatRow[]);
      setStatsTime(new Date().toLocaleString());
    }
    setStatsLoading(false);
  }, [currentSpace, runQuery]);

  useEffect(() => {
    if (tab === "statistics") loadStats();
  }, [tab, loadStats]);

  // --- Indexes ---
  const loadIndexes = useCallback(async () => {
    if (!currentSpace) return;
    setIndexesLoading(true);
    const [tRes, eRes] = await Promise.all([
      runQuery("SHOW TAG INDEXES"),
      runQuery("SHOW EDGE INDEXES"),
    ]);
    if (tRes) setTagIndexes(tRes.rows as unknown as IndexRow[]);
    if (eRes) setEdgeIndexes(eRes.rows as unknown as IndexRow[]);
    setIndexesLoading(false);
  }, [currentSpace, runQuery]);

  useEffect(() => {
    if (tab === "indexes") loadIndexes();
  }, [tab, loadIndexes]);

  // clear expanded items when space changes
  useEffect(() => {
    setExpandedItems({});
    setSearchFilter("");
  }, [currentSpace]);

  // --- Describe ---
  const toggleDescribe = useCallback(
    async (kind: "tag" | "edge", name: string) => {
      const key = `${kind}:${name}`;
      if (expandedItems[key]) {
        setExpandedItems((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      }
      setLoadingDescribe((prev) => ({ ...prev, [key]: true }));
      const stmt = kind === "tag" ? `DESCRIBE TAG ${name}` : `DESCRIBE EDGE ${name}`;
      const result = await runQuery(stmt);
      if (result) {
        setExpandedItems((prev) => ({ ...prev, [key]: result.rows as unknown as DescribeRow[] }));
      }
      setLoadingDescribe((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [expandedItems, runQuery],
  );

  // --- DDL ---
  const createSpace = () => {
    if (!newSpaceName.trim()) return;
    run(`CREATE SPACE ${newSpaceName} (vid_type = ${vidType})`);
    setNewSpaceName("");
  };

  const dropSpace = (name: string) => {
    setConfirmMsg({
      msg: `Drop space "${name}"? This cannot be undone.`,
      action: () => {
        run(`DROP SPACE ${name}`);
        setConfirmMsg(null);
      },
    });
  };

  const createTagEdge = (kind: "TAG" | "EDGE") => {
    if (!newName.trim()) return;
    const fieldsDDL = buildFieldsDDL(fields);
    run(`CREATE ${kind} ${newName} (${fieldsDDL})`);
    setNewName("");
    setFields([]);
  };

  const dropTagEdge = (kind: "TAG" | "EDGE", name: string) => {
    setConfirmMsg({
      msg: `Drop ${kind.toLowerCase()} "${name}"? This cannot be undone.`,
      action: () => {
        run(`DROP ${kind} ${name}`);
        setConfirmMsg(null);
      },
    });
  };

  const createIndex = () => {
    if (!indexName.trim() || !indexOn.trim()) return;
    const k = indexKind === "tag" ? "TAG" : "EDGE";
    run(`CREATE ${k} INDEX ${indexName} ON ${indexOn}()`);
    setIndexName("");
    setIndexOn("");
    setTimeout(loadIndexes, 500);
  };

  const rebuildIndex = (kind: "tag" | "edge", name: string) => {
    const k = kind === "tag" ? "TAG" : "EDGE";
    run(`REBUILD ${k} INDEX ${name}`);
  };

  const dropIndex = (kind: "tag" | "edge", name: string) => {
    const k = kind === "tag" ? "TAG" : "EDGE";
    setConfirmMsg({
      msg: `Drop index "${name}"?`,
      action: () => {
        run(`DROP ${k} INDEX ${name}`);
        setConfirmMsg(null);
        setTimeout(loadIndexes, 500);
      },
    });
  };

  // --- filtered lists ---
  const filteredTags = schema.tags.filter((t) =>
    t.toLowerCase().includes(searchFilter.toLowerCase()),
  );
  const filteredEdges = schema.edges.filter((e) =>
    e.toLowerCase().includes(searchFilter.toLowerCase()),
  );
  const currentIndexes = indexViewKind === "tag" ? tagIndexes : edgeIndexes;

  const statTags = stats.filter((r) => r.Type === "Tag");
  const statEdges = stats.filter((r) => r.Type === "Edge");
  const statTotal = stats.filter((r) => r.Type === "Total");

  return (
    <div className="schema-manager">
      {confirmMsg && (
        <ConfirmDialog
          message={confirmMsg.msg}
          onConfirm={confirmMsg.action}
          onCancel={() => setConfirmMsg(null)}
        />
      )}

      <div className="sm-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`sm-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "erd" ? "ERD" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className="sm-error">{error}</div>}
      {success && <div className="sm-success">{success}</div>}

      {/* ── SPACES ── */}
      {tab === "spaces" && (
        <div className="sm-section">
          <h4>Create Space</h4>
          <div className="sm-form-row">
            <input
              placeholder="space name"
              value={newSpaceName}
              onChange={(e) => setNewSpaceName(e.target.value)}
              data-testid="space-name-input"
            />
            <select value={vidType} onChange={(e) => setVidType(e.target.value)}>
              <option>INT64</option>
              <option>FIXED_STRING(32)</option>
            </select>
            <button className="sm-btn-primary" onClick={createSpace} data-testid="create-space-btn">
              Create
            </button>
          </div>
          <h4>Existing Spaces</h4>
          {spaces.map((s) => (
            <div key={s.name} className="sm-item">
              <span
                className={`sm-item-name ${s.name === currentSpace ? "current" : ""}`}
                onClick={() => onSelectSpace(s.name)}
              >
                {s.name}
              </span>
              <span className="sm-item-meta">
                P:{s.partitionNum} R:{s.replicaFactor}
              </span>
              <button className="sm-btn-danger" onClick={() => dropSpace(s.name)}>
                Drop
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── TAGS / EDGES ── */}
      {(tab === "tags" || tab === "edges") && (
        <div className="sm-section">
          {!currentSpace && <p className="sm-hint">Select a space first.</p>}
          <h4>Create {tab === "tags" ? "Tag" : "Edge"}</h4>
          <div className="sm-form-row">
            <input
              placeholder={`${tab === "tags" ? "tag" : "edge"} name`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="tag-edge-name-input"
            />
          </div>
          <FieldEditor fields={fields} onChange={setFields} />
          <button
            className="sm-btn-primary"
            onClick={() => createTagEdge(tab === "tags" ? "TAG" : "EDGE")}
            data-testid="create-tag-edge-btn"
          >
            Create {tab === "tags" ? "Tag" : "Edge"}
          </button>

          <h4 style={{ marginTop: 16 }}>
            {tab === "tags" ? "Tags" : "Edges"}
            <span className="sm-count-badge">
              {tab === "tags" ? filteredTags.length : filteredEdges.length}
            </span>
          </h4>
          <input
            className="sm-search"
            placeholder="Search..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />

          <div className="sm-list">
            {(tab === "tags" ? filteredTags : filteredEdges).map((name) => {
              const key = `${tab === "tags" ? "tag" : "edge"}:${name}`;
              const expanded = expandedItems[key];
              const loading = loadingDescribe[key];
              return (
                <div key={name} className="sm-list-item">
                  <div className="sm-list-row">
                    <button
                      className={`sm-expand-btn ${expanded ? "expanded" : ""}`}
                      onClick={() => toggleDescribe(tab === "tags" ? "tag" : "edge", name)}
                      title="Show fields"
                    >
                      {loading ? "…" : expanded ? "▾" : "▸"}
                    </button>
                    <span className="sm-list-name">{name}</span>
                    {expanded && <span className="sm-prop-num">{expanded.length} fields</span>}
                    <button
                      className="sm-btn-danger sm-btn-xs"
                      onClick={() => dropTagEdge(tab === "tags" ? "TAG" : "EDGE", name)}
                    >
                      Drop
                    </button>
                  </div>
                  {expanded && (
                    <div className="sm-describe-panel">
                      <table className="sm-describe-table">
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Type</th>
                            <th>Null</th>
                            <th>Default</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expanded.map((row) => (
                            <tr key={row.Field}>
                              <td>{row.Field}</td>
                              <td className="sm-type">{row.Type}</td>
                              <td>{row.Null}</td>
                              <td>{row.Default ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── INDEXES ── */}
      {tab === "indexes" && (
        <div className="sm-section">
          <h4>Create Index</h4>
          <div className="sm-form-row">
            <select
              value={indexKind}
              onChange={(e) => setIndexKind(e.target.value as "tag" | "edge")}
            >
              <option value="tag">Tag</option>
              <option value="edge">Edge</option>
            </select>
            <input
              placeholder="tag/edge name"
              value={indexOn}
              onChange={(e) => setIndexOn(e.target.value)}
            />
            <input
              placeholder="index name"
              value={indexName}
              onChange={(e) => setIndexName(e.target.value)}
            />
            <button className="sm-btn-primary" onClick={createIndex} data-testid="create-index-btn">
              Create
            </button>
          </div>

          <div className="sm-idx-toolbar">
            <div className="sm-toggle-group">
              <button
                className={`sm-toggle ${indexViewKind === "tag" ? "active" : ""}`}
                onClick={() => setIndexViewKind("tag")}
              >
                Tag
              </button>
              <button
                className={`sm-toggle ${indexViewKind === "edge" ? "active" : ""}`}
                onClick={() => setIndexViewKind("edge")}
              >
                Edge
              </button>
            </div>
            <button className="sm-btn-ghost" onClick={loadIndexes} disabled={indexesLoading}>
              {indexesLoading ? "…" : "↺ Refresh"}
            </button>
          </div>

          {currentIndexes.length === 0 ? (
            <p className="sm-hint">{indexesLoading ? "Loading…" : "No indexes found."}</p>
          ) : (
            <table className="sm-index-table">
              <thead>
                <tr>
                  <th>Index Name</th>
                  <th>{indexViewKind === "tag" ? "On Tag" : "On Edge"}</th>
                  <th>Fields</th>
                  <th>Operations</th>
                </tr>
              </thead>
              <tbody>
                {currentIndexes.map((idx) => {
                  const idxName = idx["Index Name"];
                  const onName = idx["On Tag"] ?? idx["On Edge"] ?? "";
                  const fieldStr = idx["Fields"] ?? "—";
                  return (
                    <tr key={idxName}>
                      <td className="sm-idx-name">{idxName}</td>
                      <td>{onName}</td>
                      <td className="sm-idx-fields">{fieldStr}</td>
                      <td className="sm-idx-ops">
                        <button
                          className="sm-btn-rebuild"
                          onClick={() => rebuildIndex(indexViewKind, idxName)}
                        >
                          Rebuild
                        </button>
                        <button
                          className="sm-btn-danger sm-btn-xs"
                          onClick={() => dropIndex(indexViewKind, idxName)}
                        >
                          Drop
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── STATISTICS ── */}
      {tab === "statistics" && (
        <div className="sm-section">
          {!currentSpace ? (
            <p className="sm-hint">Select a space first.</p>
          ) : (
            <>
              <div className="sm-stats-toolbar">
                <button className="sm-btn-primary" onClick={loadStats} disabled={statsLoading}>
                  {statsLoading ? "Loading…" : "↺ Refresh"}
                </button>
                {statsTime && <span className="sm-stats-time">Last refreshed: {statsTime}</span>}
                {statTotal.length > 0 && (
                  <span className="sm-stats-totals">
                    {statTotal.map((r) => (
                      <span key={r.Name} className="sm-stats-total-chip">
                        Total {r.Name}: <strong>{r.Count.toLocaleString()}</strong>
                      </span>
                    ))}
                  </span>
                )}
              </div>

              {stats.length === 0 ? (
                <p className="sm-hint">{statsLoading ? "Loading…" : "No data. Click Refresh."}</p>
              ) : (
                <table className="sm-stats-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Name</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...statTags, ...statEdges].map((row) => (
                      <tr key={`${row.Type}-${row.Name}`}>
                        <td>
                          <span className={`sm-type-chip ${row.Type.toLowerCase()}`}>
                            {row.Type}
                          </span>
                        </td>
                        <td className="sm-stats-name">{row.Name}</td>
                        <td className="sm-stats-count">{row.Count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}

      {/* ── ERD ── */}
      {tab === "erd" && (
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <ErdDiagram schema={schema} currentSpace={currentSpace} />
        </div>
      )}
    </div>
  );
}

export default SchemaManager;
