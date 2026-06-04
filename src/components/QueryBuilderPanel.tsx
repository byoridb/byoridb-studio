import { useState } from "react";
import type { SchemaInfo } from "../types";
import {
  buildMatchQuery,
  BUILDER_OPERATORS,
  type BuilderCondition,
  type EdgeDirection,
} from "../lib/queryBuilder";
import "../styles/QueryBuilderPanel.css";

interface QueryBuilderPanelProps {
  schema: SchemaInfo;
  onRun: (query: string) => void;
}

const DIRECTIONS: { value: EdgeDirection; label: string }[] = [
  { value: "out", label: "→ outgoing" },
  { value: "in", label: "← incoming" },
  { value: "both", label: "↔ both" },
];

function QueryBuilderPanel({ schema, onRun }: QueryBuilderPanelProps) {
  const [startTag, setStartTag] = useState("");
  const [conditions, setConditions] = useState<BuilderCondition[]>([]);
  const [edgeEnabled, setEdgeEnabled] = useState(false);
  const [edgeName, setEdgeName] = useState("");
  const [direction, setDirection] = useState<EdgeDirection>("out");
  const [endTag, setEndTag] = useState("");
  const [limit, setLimit] = useState(100);

  const query = buildMatchQuery({
    startTag,
    conditions,
    edge: edgeEnabled && edgeName ? { name: edgeName, direction } : null,
    endTag,
    limit,
  });

  const updateCondition = (i: number, patch: Partial<BuilderCondition>) =>
    setConditions((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const addCondition = () =>
    setConditions((prev) => [...prev, { property: "", op: "==", value: "" }]);

  const removeCondition = (i: number) =>
    setConditions((prev) => prev.filter((_, idx) => idx !== i));

  if (schema.tags.length === 0) {
    return (
      <div className="query-builder">
        <div className="qb-empty">No tags in this space yet — create one to build a query.</div>
      </div>
    );
  }

  return (
    <div className="query-builder">
      <div className="qb-field">
        <label className="qb-label">Start node tag</label>
        <select
          className="qb-select"
          value={startTag}
          onChange={(e) => setStartTag(e.target.value)}
          data-testid="qb-start-tag"
        >
          <option value="">— select tag —</option>
          {schema.tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="qb-field">
        <div className="qb-label-row">
          <label className="qb-label">Where</label>
          <button className="qb-add" onClick={addCondition} data-testid="qb-add-condition">
            + condition
          </button>
        </div>
        {conditions.map((c, i) => (
          <div className="qb-condition" key={i}>
            <input
              className="qb-input qb-prop"
              placeholder="property"
              value={c.property}
              onChange={(e) => updateCondition(i, { property: e.target.value })}
              data-testid={`qb-cond-prop-${i}`}
            />
            <select
              className="qb-select qb-op"
              value={c.op}
              onChange={(e) => updateCondition(i, { op: e.target.value })}
              data-testid={`qb-cond-op-${i}`}
            >
              {BUILDER_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              className="qb-input qb-value"
              placeholder="value"
              value={c.value}
              onChange={(e) => updateCondition(i, { value: e.target.value })}
              data-testid={`qb-cond-value-${i}`}
            />
            <button
              className="qb-remove"
              onClick={() => removeCondition(i)}
              aria-label={`Remove condition ${i + 1}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="qb-field">
        <label className="qb-checkbox">
          <input
            type="checkbox"
            checked={edgeEnabled}
            onChange={(e) => setEdgeEnabled(e.target.checked)}
            data-testid="qb-edge-toggle"
          />
          Traverse a relationship
        </label>
        {edgeEnabled && (
          <div className="qb-edge">
            <select
              className="qb-select"
              value={edgeName}
              onChange={(e) => setEdgeName(e.target.value)}
              data-testid="qb-edge-name"
            >
              <option value="">— select edge —</option>
              {schema.edges.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <select
              className="qb-select"
              value={direction}
              onChange={(e) => setDirection(e.target.value as EdgeDirection)}
              data-testid="qb-edge-direction"
            >
              {DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <select
              className="qb-select"
              value={endTag}
              onChange={(e) => setEndTag(e.target.value)}
              data-testid="qb-end-tag"
            >
              <option value="">end: any</option>
              {schema.tags.map((t) => (
                <option key={t} value={t}>
                  end: {t}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="qb-field qb-limit-field">
        <label className="qb-label">Limit</label>
        <input
          className="qb-input qb-limit"
          type="number"
          min={0}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          data-testid="qb-limit"
        />
      </div>

      <pre className="qb-preview" data-testid="qb-preview">
        {query || "Select a start tag to generate a query."}
      </pre>

      <button
        className="qb-run"
        disabled={!query}
        onClick={() => query && onRun(query)}
        data-testid="qb-run"
      >
        ▶ Run query
      </button>
    </div>
  );
}

export default QueryBuilderPanel;
