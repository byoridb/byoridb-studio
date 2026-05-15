import { useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { QueryResult } from "../types";
import { parseGraphElements, tagColor } from "../lib/graph-parser";
import "../styles/GraphView.css";

interface GraphViewProps {
  result: QueryResult;
}

interface NodeDetail {
  id: string;
  tag?: string;
  props: Record<string, string>;
}

function GraphView({ result }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [selected, setSelected] = useState<NodeDetail | null>(null);
  const [elementCount, setElementCount] = useState({ nodes: 0, edges: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    const elements = parseGraphElements(result);
    const tagIndex = new Map<string, number>();

    const nodes = elements.filter((e) => e.group === "nodes");
    const edges = elements.filter((e) => e.group === "edges");
    setElementCount({ nodes: nodes.length, edges: edges.length });

    if (elements.length === 0) return;

    cyRef.current?.destroy();

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele: cytoscape.NodeSingular) =>
              tagColor(ele.data("tag"), tagIndex),
            label: "data(label)",
            color: "#cdd6f4",
            "font-size": 11,
            "text-valign": "bottom",
            "text-margin-y": 4,
            "border-width": 2,
            "border-color": "#313244",
            width: 36,
            height: 36,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-color": "#f5c2e7",
            "border-width": 3,
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#45475a",
            "target-arrow-color": "#45475a",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 9,
            color: "#6c7086",
            "text-rotation": "autorotate",
          },
        },
        {
          selector: "edge:selected",
          style: { "line-color": "#89b4fa", "target-arrow-color": "#89b4fa" },
        },
      ],
      layout: {
        name: elements.length > 50 ? "cose" : "cose",
        animate: false,
        padding: 30,
      } as cytoscape.LayoutOptions,
    });

    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      setSelected({ id: node.id(), tag: node.data("tag"), props: node.data("props") });
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelected(null);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [result]);

  const elements = parseGraphElements(result);

  if (elements.length === 0) {
    return (
      <div className="graph-empty">
        <span>No graph data detected.</span>
        <span className="graph-hint">
          Run a GO, MATCH, or FIND PATH query to visualize results.
        </span>
      </div>
    );
  }

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <span className="graph-stats">
          {elementCount.nodes} nodes · {elementCount.edges} edges
        </span>
        <button
          className="graph-fit-btn"
          onClick={() => cyRef.current?.fit(undefined, 30)}
          title="Fit to screen"
        >
          ⊡ Fit
        </button>
        <button
          className="graph-reset-btn"
          onClick={() => cyRef.current?.reset()}
          title="Reset zoom"
        >
          ↺ Reset
        </button>
      </div>

      <div className="graph-body">
        <div ref={containerRef} className="graph-canvas" data-testid="graph-canvas" />

        {selected && (
          <div className="graph-detail" data-testid="graph-detail">
            <div className="graph-detail-header">
              <span className="graph-detail-id">{selected.id}</span>
              {selected.tag && <span className="graph-detail-tag">{selected.tag}</span>}
              <button className="graph-detail-close" onClick={() => setSelected(null)}>
                ×
              </button>
            </div>
            <div className="graph-detail-props">
              {Object.entries(selected.props).map(([k, v]) => (
                <div key={k} className="graph-detail-row">
                  <span className="graph-detail-key">{k}</span>
                  <span className="graph-detail-val">{v || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default GraphView;
