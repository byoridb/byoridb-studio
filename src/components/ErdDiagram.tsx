import { useEffect, useRef, useState, useCallback } from "react";
import cytoscape from "cytoscape";
import { invoke } from "@tauri-apps/api/core";
import type { SchemaInfo, QueryResult } from "../types";
import "../styles/GraphView.css";

interface ErdDiagramProps {
  schema: SchemaInfo;
  currentSpace: string | null;
}

interface Relation {
  edge: string;
  srcTag: string | null;
  dstTag: string | null;
  dangling: boolean;
}

// Pastel palette for tag nodes (color picked by stable hash of tag name)
const PALETTE = [
  "#cba6f7", // mauve
  "#89b4fa", // blue
  "#f9e2af", // yellow
  "#f5c2e7", // pink
  "#a6e3a1", // green
  "#fab387", // peach
  "#94e2d5", // teal
  "#74c7ec", // sapphire
  "#eba0ac", // maroon
];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 100003;
  return PALETTE[hash % PALETTE.length];
}

async function safeQuery(query: string): Promise<QueryResult | null> {
  try {
    return await invoke<QueryResult>("execute_query", { query });
  } catch {
    return null;
  }
}

/**
 * Infer edge → (src tag, dst tag) relations by sampling actual data.
 * ByoriDB / nGQL schemas don't enforce binding between tags and edges, so
 * we mirror NebulaGraph Studio's approach: pick one row per edge, map the
 * endpoint VIDs back to tags using a per-tag VID lookup.
 */
async function inferRelations(schema: SchemaInfo): Promise<Relation[]> {
  // VID → tag map (sample up to 500 per tag)
  const vidToTag = new Map<string, string>();
  for (const tag of schema.tags) {
    const r = await safeQuery(`MATCH (n:${tag}) RETURN id(n) AS vid LIMIT 500`);
    if (!r) continue;
    for (const row of r.rows) {
      const vid = row.vid;
      if (vid !== null && vid !== undefined) vidToTag.set(String(vid), tag);
    }
  }

  // Sample one edge per type to derive (src tag, dst tag)
  const relations: Relation[] = [];
  for (const edge of schema.edges) {
    const r = await safeQuery(
      `MATCH (a)-[e:${edge}]->(b) RETURN id(a) AS src, id(b) AS dst LIMIT 1`,
    );
    if (!r || r.rows.length === 0) {
      relations.push({ edge, srcTag: null, dstTag: null, dangling: true });
      continue;
    }
    const src = r.rows[0].src;
    const dst = r.rows[0].dst;
    const srcTag = src !== null && src !== undefined ? vidToTag.get(String(src)) ?? null : null;
    const dstTag = dst !== null && dst !== undefined ? vidToTag.get(String(dst)) ?? null : null;
    relations.push({ edge, srcTag, dstTag, dangling: !srcTag || !dstTag });
  }
  return relations;
}

function ErdDiagram({ schema, currentSpace }: ErdDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!currentSpace || schema.tags.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const r = await inferRelations(schema);
      setRelations(r);
      setLastRefreshed(new Date());
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [currentSpace, schema]);

  // Auto-load when schema/space changes
  useEffect(() => {
    setRelations([]);
    setLastRefreshed(null);
    if (currentSpace && (schema.tags.length > 0 || schema.edges.length > 0)) {
      refresh();
    }
  }, [currentSpace, schema, refresh]);

  // Render cytoscape graph whenever relations or schema change
  useEffect(() => {
    if (!containerRef.current) return;
    if (schema.tags.length === 0 && schema.edges.length === 0) return;

    cyRef.current?.destroy();

    const elements: cytoscape.ElementDefinition[] = [];

    schema.tags.forEach((tag) => {
      elements.push({
        group: "nodes",
        data: { id: `tag:${tag}`, label: tag, color: colorFor(tag), kind: "tag" },
      });
    });

    // Dangling placeholder node (only added if any dangling edge exists)
    const hasDangling = relations.some((r) => r.dangling);
    if (hasDangling) {
      elements.push({
        group: "nodes",
        data: { id: "dangling:placeholder", label: "?", kind: "dangling" },
      });
    }

    // If we have relations data, use it; otherwise show all tags + edges as "unknown"
    if (relations.length > 0) {
      relations.forEach((rel) => {
        const src = rel.srcTag ? `tag:${rel.srcTag}` : "dangling:placeholder";
        const dst = rel.dstTag ? `tag:${rel.dstTag}` : "dangling:placeholder";
        elements.push({
          group: "edges",
          data: {
            id: `edge:${rel.edge}:${src}:${dst}`,
            source: src,
            target: dst,
            label: rel.edge,
            dangling: rel.dangling ? "true" : "false",
          },
        });
      });
    } else {
      // No relations inferred yet — show all edges as dangling self-loops
      schema.edges.forEach((edge) => {
        if (schema.tags.length > 0) {
          elements.push({
            group: "edges",
            data: {
              id: `edge:${edge}:unknown`,
              source: `tag:${schema.tags[0]}`,
              target: `tag:${schema.tags[0]}`,
              label: edge,
              dangling: "true",
            },
          });
        }
      });
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node[kind="tag"]',
          style: {
            "background-color": "data(color)",
            "border-color": "#313244",
            "border-width": 2,
            label: "data(label)",
            color: "#1e1e2e",
            "font-size": 12,
            "font-weight": "bold",
            "text-valign": "center",
            "text-halign": "center",
            shape: "ellipse",
            width: 70,
            height: 70,
            "text-wrap": "ellipsis",
            "text-max-width": "60px",
          },
        },
        {
          selector: 'node[kind="dangling"]',
          style: {
            "background-color": "#1e1e2e",
            "background-opacity": 0,
            "border-color": "#6c7086",
            "border-width": 2,
            "border-style": "dashed",
            label: "data(label)",
            color: "#6c7086",
            "font-size": 14,
            "font-weight": "bold",
            "text-valign": "center",
            "text-halign": "center",
            shape: "ellipse",
            width: 50,
            height: 50,
          },
        },
        {
          selector: 'edge[dangling="false"]',
          style: {
            width: 1.5,
            "line-color": "#6c7086",
            "target-arrow-color": "#6c7086",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 10,
            color: "#cdd6f4",
            "text-background-color": "#1e1e2e",
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "text-rotation": "autorotate",
          },
        },
        {
          selector: 'edge[dangling="true"]',
          style: {
            width: 1.5,
            "line-color": "#6c7086",
            "line-style": "dashed",
            "target-arrow-color": "#6c7086",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 10,
            color: "#a6adc8",
            "text-background-color": "#1e1e2e",
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "text-rotation": "autorotate",
          },
        },
      ],
      layout: {
        name: "cose",
        animate: false,
        padding: 50,
        idealEdgeLength: () => 140,
        nodeRepulsion: () => 8000,
      } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 3,
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [schema, relations]);

  const zoomIn = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: Math.min(cy.zoom() * 1.25, 3), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const zoomOut = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: Math.max(cy.zoom() / 1.25, 0.2), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const fit = () => cyRef.current?.fit(undefined, 40);

  if (!currentSpace) {
    return (
      <div className="graph-empty">
        <span>Select a space to view the ERD diagram.</span>
      </div>
    );
  }

  if (schema.tags.length === 0 && schema.edges.length === 0) {
    return (
      <div className="graph-empty">
        <span>No tags or edges in this space.</span>
      </div>
    );
  }

  return (
    <div className="erd-diagram">
      <div className="erd-toolbar">
        <button className="erd-refresh-btn" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
        {lastRefreshed && (
          <span className="erd-last-refreshed">
            Last refreshed: {lastRefreshed.toLocaleString()}
          </span>
        )}
        {error && <span className="erd-error">{error}</span>}
        <span className="erd-hint">
          {schema.tags.length} tags · {schema.edges.length} edges
        </span>
      </div>

      <div className="erd-canvas-wrap">
        <div ref={containerRef} className="graph-canvas erd-canvas" data-testid="erd-canvas" />

        <div className="erd-legend-box">
          <div className="erd-legend-item">
            <span className="erd-legend-dot tag" />
            <span>Tag</span>
          </div>
          <div className="erd-legend-item">
            <span className="erd-legend-arrow" />
            <span>Edge type</span>
          </div>
          <div className="erd-legend-item">
            <span className="erd-legend-arrow dashed" />
            <span>Dangling edge</span>
          </div>
        </div>

        <div className="erd-zoom-controls">
          <button onClick={zoomIn} title="Zoom in" aria-label="Zoom in">
            +
          </button>
          <button onClick={zoomOut} title="Zoom out" aria-label="Zoom out">
            −
          </button>
          <button onClick={fit} title="Fit" aria-label="Fit">
            ⤢
          </button>
        </div>
      </div>
    </div>
  );
}

export default ErdDiagram;
