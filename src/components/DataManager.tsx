import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SchemaInfo } from "../types";
import "../styles/DataManager.css";

interface DataManagerProps {
  currentSpace: string | null;
  schema: SchemaInfo;
  onExecuteQuery: (q: string) => void;
}

function DataManager({ currentSpace, schema, onExecuteQuery }: DataManagerProps) {
  const [tab, setTab] = useState<"vertex" | "edge" | "import">("vertex");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Vertex form
  const [vid, setVid] = useState("");
  const [vTag, setVTag] = useState("");
  const [vProps, setVProps] = useState("");

  // Edge form
  const [eSrc, setESrc] = useState("");
  const [eDst, setEDst] = useState("");
  const [eType, setEType] = useState("");
  const [eProps, setEProps] = useState("");

  // CSV import
  const [csvKind, setCsvKind] = useState<"vertex" | "edge">("vertex");
  const [csvTag, setCsvTag] = useState("");
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [csvProgress, setCsvProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (stmt: string) => {
    setError("");
    setSuccess("");
    try {
      await invoke("execute_statement", { statement: stmt });
      setSuccess("✓ Done");
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
    }
  };

  const insertVertex = () => {
    if (!vid.trim() || !vTag.trim()) return;
    const propStr = vProps.trim() ? `(${vProps})` : "()";
    run(
      `INSERT VERTEX ${vTag} ${propStr} VALUES ${vid}:(${
        vProps.trim()
          ? vProps
              .split(",")
              .map(() => "''")
              .join(",")
          : ""
      })`,
    );
  };

  const deleteVertex = () => {
    if (!vid.trim()) return;
    run(`DELETE VERTEX ${vid}`);
  };

  const insertEdge = () => {
    if (!eSrc.trim() || !eDst.trim() || !eType.trim()) return;
    const propStr = eProps.trim() ? `(${eProps})` : "()";
    run(
      `INSERT EDGE ${eType} ${propStr} VALUES ${eSrc} -> ${eDst}:(${
        eProps.trim()
          ? eProps
              .split(",")
              .map(() => "''")
              .join(",")
          : ""
      })`,
    );
  };

  const deleteEdge = () => {
    if (!eSrc.trim() || !eDst.trim() || !eType.trim()) return;
    run(`DELETE EDGE ${eType} ${eSrc} -> ${eDst}`);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = text
        .trim()
        .split("\n")
        .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
      setCsvPreview(rows.slice(0, 5));
    };
    reader.readAsText(file);
  };

  const importCsv = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !csvTag.trim()) return;
    const text = await file.text();
    const rows = text
      .trim()
      .split("\n")
      .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
    const [header, ...dataRows] = rows;
    setCsvProgress({ done: 0, total: dataRows.length });
    setError("");
    setSuccess("");

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const vals = row.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ");
      const cols = header.join(", ");
      let stmt: string;
      if (csvKind === "vertex") {
        const id = row[0];
        stmt = `INSERT VERTEX ${csvTag} (${cols}) VALUES ${id}:(${vals})`;
      } else {
        const [src, dst, ...rest] = row;
        const restVals = rest.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ");
        stmt = `INSERT EDGE ${csvTag} (${header.slice(2).join(", ")}) VALUES ${src} -> ${dst}:(${restVals})`;
      }
      try {
        await invoke("execute_statement", { statement: stmt });
      } catch {
        // continue on row errors
      }
      setCsvProgress({ done: i + 1, total: dataRows.length });
    }
    setSuccess(`✓ Imported ${dataRows.length} rows`);
    setCsvProgress(null);
  };

  if (!currentSpace) {
    return (
      <div className="data-manager">
        <p className="dm-hint">Select a space first.</p>
      </div>
    );
  }

  return (
    <div className="data-manager">
      <div className="dm-tabs">
        {(["vertex", "edge", "import"] as const).map((t) => (
          <button
            key={t}
            className={`dm-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className="dm-error">{error}</div>}
      {success && <div className="dm-success">{success}</div>}

      {tab === "vertex" && (
        <div className="dm-section">
          <h4>Vertex</h4>
          <div className="dm-form">
            <label>VID</label>
            <input
              value={vid}
              onChange={(e) => setVid(e.target.value)}
              placeholder="1"
              data-testid="vid-input"
            />
            <label>Tag</label>
            <select
              value={vTag}
              onChange={(e) => setVTag(e.target.value)}
              data-testid="vtag-select"
            >
              <option value="">-- select tag --</option>
              {schema.tags.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <label>Props (comma-separated values)</label>
            <input
              value={vProps}
              onChange={(e) => setVProps(e.target.value)}
              placeholder="'Alice', 30"
            />
          </div>
          <div className="dm-actions">
            <button
              className="dm-btn-primary"
              onClick={insertVertex}
              data-testid="insert-vertex-btn"
            >
              Insert
            </button>
            <button className="dm-btn-danger" onClick={deleteVertex}>
              Delete VID
            </button>
            <button
              className="dm-btn-secondary"
              onClick={() => onExecuteQuery(`FETCH PROP ON * ${vid}`)}
            >
              Fetch
            </button>
          </div>
        </div>
      )}

      {tab === "edge" && (
        <div className="dm-section">
          <h4>Edge</h4>
          <div className="dm-form">
            <label>Edge Type</label>
            <select
              value={eType}
              onChange={(e) => setEType(e.target.value)}
              data-testid="etype-select"
            >
              <option value="">-- select edge --</option>
              {schema.edges.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
            <label>Src VID</label>
            <input value={eSrc} onChange={(e) => setESrc(e.target.value)} placeholder="1" />
            <label>Dst VID</label>
            <input value={eDst} onChange={(e) => setEDst(e.target.value)} placeholder="2" />
            <label>Props (comma-separated values)</label>
            <input value={eProps} onChange={(e) => setEProps(e.target.value)} placeholder="2020" />
          </div>
          <div className="dm-actions">
            <button className="dm-btn-primary" onClick={insertEdge} data-testid="insert-edge-btn">
              Insert
            </button>
            <button className="dm-btn-danger" onClick={deleteEdge}>
              Delete Edge
            </button>
          </div>
        </div>
      )}

      {tab === "import" && (
        <div className="dm-section">
          <h4>CSV Import</h4>
          <div className="dm-form">
            <label>Kind</label>
            <select
              value={csvKind}
              onChange={(e) => setCsvKind(e.target.value as "vertex" | "edge")}
            >
              <option value="vertex">Vertex</option>
              <option value="edge">Edge</option>
            </select>
            <label>Tag / Edge type</label>
            <input
              value={csvTag}
              onChange={(e) => setCsvTag(e.target.value)}
              placeholder="person"
              data-testid="csv-tag-input"
            />
            <label>CSV file (first column = VID for vertex, src/dst for edge)</label>
            <input
              type="file"
              accept=".csv"
              ref={fileRef}
              onChange={handleFileChange}
              data-testid="csv-file-input"
            />
          </div>
          {csvPreview.length > 0 && (
            <div className="dm-preview">
              <p className="dm-hint">Preview (first 5 rows):</p>
              <table className="dm-preview-table">
                <tbody>
                  {csvPreview.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {csvProgress && (
            <div className="dm-progress">
              Importing {csvProgress.done} / {csvProgress.total}…
            </div>
          )}
          <button className="dm-btn-primary" onClick={importCsv} data-testid="import-csv-btn">
            Import
          </button>
        </div>
      )}
    </div>
  );
}

export default DataManager;
