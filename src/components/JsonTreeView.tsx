import { useState, useMemo } from "react";

interface JsonTreeViewProps {
  data: unknown;
  search?: string;
}

interface NodeProps {
  keyName: string | number | null;
  value: unknown;
  depth: number;
  search: string;
  defaultExpanded?: boolean;
}

function highlight(text: string, search: string): React.ReactNode {
  if (!search) return text;
  const idx = text.toLowerCase().indexOf(search.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="json-highlight">{text.slice(idx, idx + search.length)}</mark>
      {text.slice(idx + search.length)}
    </>
  );
}

function JsonNode({ keyName, value, depth, search, defaultExpanded = true }: NodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const isObject = value !== null && typeof value === "object";
  const isArray = Array.isArray(value);
  const entries = isObject ? Object.entries(value as Record<string, unknown>) : [];
  const count = entries.length;

  const keyLabel =
    keyName !== null ? (
      <span className="json-key">{highlight(String(keyName), search)}: </span>
    ) : null;

  if (!isObject) {
    const str = value === null ? "null" : typeof value === "string" ? `"${value}"` : String(value);
    const cls =
      value === null
        ? "json-null"
        : typeof value === "string"
          ? "json-string"
          : typeof value === "boolean"
            ? "json-bool"
            : "json-number";
    return (
      <div className="json-row" style={{ paddingLeft: depth * 16 }}>
        {keyLabel}
        <span className={cls}>{highlight(str, search)}</span>
      </div>
    );
  }

  const bracket = isArray ? ["[", "]"] : ["{", "}"];

  return (
    <div>
      <div
        className="json-row json-expandable"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setExpanded((v) => !v)}
        data-testid={`json-node-${keyName ?? "root"}`}
      >
        <span className="json-toggle">{expanded ? "▾" : "▸"}</span>
        {keyLabel}
        <span className="json-bracket">{bracket[0]}</span>
        {!expanded && (
          <span className="json-collapsed">{isArray ? `${count} items` : `${count} keys`}</span>
        )}
        {!expanded && <span className="json-bracket">{bracket[1]}</span>}
      </div>
      {expanded && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              keyName={isArray ? Number(k) : k}
              value={v}
              depth={depth + 1}
              search={search}
              defaultExpanded={depth < 1}
            />
          ))}
          <div className="json-row" style={{ paddingLeft: depth * 16 }}>
            <span className="json-bracket">{bracket[1]}</span>
          </div>
        </>
      )}
    </div>
  );
}

function JsonTreeView({ data, search = "" }: JsonTreeViewProps) {
  const rows = useMemo(() => (Array.isArray(data) ? data : [data]), [data]);

  return (
    <div className="json-tree">
      {rows.map((row, i) => (
        <JsonNode
          key={i}
          keyName={rows.length > 1 ? i : null}
          value={row}
          depth={0}
          search={search}
          defaultExpanded={true}
        />
      ))}
    </div>
  );
}

export default JsonTreeView;
