import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SpaceInfo } from "../types";
import "../styles/SchemaManager.css";

interface SchemaManagerProps {
  spaces: SpaceInfo[];
  currentSpace: string | null;
  onRefresh: () => void;
  onSelectSpace: (name: string) => void;
}

interface TagEdgeField {
  name: string;
  type: string;
  nullable: boolean;
}

const FIELD_TYPES = ["STRING", "INT64", "INT32", "FLOAT", "DOUBLE", "BOOL", "TIMESTAMP", "DATE"];

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

function SchemaManager({ spaces, currentSpace, onRefresh, onSelectSpace }: SchemaManagerProps) {
  const [tab, setTab] = useState<"spaces" | "tags" | "edges" | "indexes">("spaces");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [vidType, setVidType] = useState("INT64");
  const [newName, setNewName] = useState("");
  const [fields, setFields] = useState<TagEdgeField[]>([]);
  const [indexName, setIndexName] = useState("");
  const [indexOn, setIndexOn] = useState("");
  const [indexKind, setIndexKind] = useState<"tag" | "edge">("tag");

  const run = async (stmt: string) => {
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
  };

  const createSpace = () => {
    if (!newSpaceName.trim()) return;
    run(`CREATE SPACE ${newSpaceName} (vid_type = ${vidType})`);
    setNewSpaceName("");
  };

  const dropSpace = (name: string) => {
    if (!confirm(`Drop space "${name}"? This cannot be undone.`)) return;
    run(`DROP SPACE ${name}`);
  };

  const createTagEdge = (kind: "TAG" | "EDGE") => {
    if (!newName.trim()) return;
    const fieldsDDL = buildFieldsDDL(fields);
    run(`CREATE ${kind} ${newName} (${fieldsDDL})`);
    setNewName("");
    setFields([]);
  };

  const createIndex = () => {
    if (!indexName.trim() || !indexOn.trim()) return;
    const k = indexKind === "tag" ? "TAG" : "EDGE";
    run(`CREATE ${k} INDEX ${indexName} ON ${indexOn}()`);
    setIndexName("");
    setIndexOn("");
  };

  return (
    <div className="schema-manager">
      <div className="sm-tabs">
        {(["spaces", "tags", "edges", "indexes"] as const).map((t) => (
          <button
            key={t}
            className={`sm-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className="sm-error">{error}</div>}
      {success && <div className="sm-success">{success}</div>}

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
          <p className="sm-hint">To drop a tag/edge, use the Query Editor: DROP TAG &lt;name&gt;</p>
        </div>
      )}

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
          <p className="sm-hint">
            To list/drop indexes, use the Query Editor: SHOW TAG INDEXES / DROP TAG INDEX
            &lt;name&gt;
          </p>
        </div>
      )}
    </div>
  );
}

export default SchemaManager;
