import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import type { SchemaInfo } from "../types";
import "../styles/GraphView.css"; // reuse graph styles

interface ErdDiagramProps {
  schema: SchemaInfo;
  currentSpace: string | null;
}

/**
 * ERD-style diagram showing Tags as nodes and Edges as directed connections.
 * Since ByoriDB edges don't carry explicit src/dst tag constraints in the
 * schema API, we render each edge type as a self-loop on a central "hub" node
 * and each tag as its own node. When the schema is empty we show a hint.
 */
function ErdDiagram({ schema, currentSpace }: ErdDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (schema.tags.length === 0 && schema.edges.length === 0) return;

    cyRef.current?.destroy();

    const elements: cytoscape.ElementDefinition[] = [];

    // Tag nodes
    schema.tags.forEach((tag) => {
      elements.push({ group: "nodes", data: { id: `tag:${tag}`, label: tag, kind: "tag" } });
    });

    // Edge type nodes (diamond shape via style)
    schema.edges.forEach((edge) => {
      elements.push({
        group: "nodes",
        data: { id: `edge:${edge}`, label: edge, kind: "edge" },
      });
    });

    // Connect each edge type to all tags (since we don't know src/dst constraints)
    // Use a single representative connection to avoid clutter: edge → first tag
    schema.edges.forEach((edge) => {
      if (schema.tags.length > 0) {
        elements.push({
          group: "edges",
          data: {
            id: `rel:${edge}`,
            source: `tag:${schema.tags[0]}`,
            target: `edge:${edge}`,
          },
        });
      }
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node[kind="tag"]',
          style: {
            "background-color": "#89b4fa",
            label: "data(label)",
            color: "#cdd6f4",
            "font-size": 12,
            "text-valign": "center",
            "border-width": 2,
            "border-color": "#313244",
            shape: "roundrectangle",
            width: 80,
            height: 36,
            "text-wrap": "wrap",
            "text-max-width": "76px",
          },
        },
        {
          selector: 'node[kind="edge"]',
          style: {
            "background-color": "#cba6f7",
            label: "data(label)",
            color: "#cdd6f4",
            "font-size": 11,
            "text-valign": "center",
            "border-width": 2,
            "border-color": "#313244",
            shape: "diamond",
            width: 70,
            height: 40,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#45475a",
            "target-arrow-color": "#45475a",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
          },
        },
      ],
      layout: {
        name: "cose",
        animate: false,
        padding: 30,
      } as cytoscape.LayoutOptions,
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [schema]);

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
      <div className="erd-legend">
        <span className="erd-legend-tag">■ Tag</span>
        <span className="erd-legend-edge">◆ Edge type</span>
        <span className="erd-hint">
          {schema.tags.length} tags · {schema.edges.length} edge types
        </span>
      </div>
      <div
        ref={containerRef}
        className="graph-canvas"
        style={{ height: "calc(100% - 32px)" }}
        data-testid="erd-canvas"
      />
    </div>
  );
}

export default ErdDiagram;
