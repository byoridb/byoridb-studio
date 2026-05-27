/**
 * Parse QueryResult rows into Cytoscape elements (nodes + edges).
 *
 * Heuristics:
 * - A row with `_src` and `_dst` columns → edge
 * - A row with `id` or `_id` column → vertex node
 * - Otherwise each row becomes a node with a generated id
 */
import type { QueryResult } from "../types";

export interface CyNode {
  data: { id: string; label: string; tag?: string; props: Record<string, string> };
}

export interface CyEdge {
  data: {
    id: string;
    source: string;
    target: string;
    label: string;
    props: Record<string, string>;
  };
}

export type CyElement =
  | { group: "nodes"; data: CyNode["data"] }
  | { group: "edges"; data: CyEdge["data"] };

function strVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function parseGraphElements(result: QueryResult): CyElement[] {
  const elements: CyElement[] = [];
  const nodeIds = new Set<string>();

  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i];
    const keys = Object.keys(row);

    // Edge detection: has _src and _dst
    const srcKey = keys.find((k) => k === "_src" || k.endsWith("._src"));
    const dstKey = keys.find((k) => k === "_dst" || k.endsWith("._dst"));

    if (srcKey && dstKey) {
      const src = strVal(row[srcKey]);
      const dst = strVal(row[dstKey]);
      if (!src || !dst) continue;

      // Ensure source/target nodes exist
      if (!nodeIds.has(src)) {
        nodeIds.add(src);
        elements.push({ group: "nodes", data: { id: src, label: src, props: {} } });
      }
      if (!nodeIds.has(dst)) {
        nodeIds.add(dst);
        elements.push({ group: "nodes", data: { id: dst, label: dst, props: {} } });
      }

      const edgeLabel = keys.find((k) => k !== srcKey && k !== dstKey) ?? "edge";
      const props: Record<string, string> = {};
      keys.forEach((k) => {
        if (k !== srcKey && k !== dstKey) props[k] = strVal(row[k]);
      });

      elements.push({
        group: "edges",
        data: { id: `e-${i}`, source: src, target: dst, label: edgeLabel, props },
      });
      continue;
    }

    // Node detection
    const idKey = keys.find((k) => k === "id" || k === "_id" || k === "VID");
    const id = idKey ? strVal(row[idKey]) : `node-${i}`;
    const tagKey = keys.find((k) => k === "tag" || k === "_tag" || k === "Tag");
    const tag = tagKey ? strVal(row[tagKey]) : undefined;

    const props: Record<string, string> = {};
    keys.forEach((k) => {
      props[k] = strVal(row[k]);
    });

    const labelKey = keys.find((k) => k === "name" || k === "label") ?? keys[0];
    const label = labelKey ? strVal(row[labelKey]) || id : id;

    if (!nodeIds.has(id)) {
      nodeIds.add(id);
      elements.push({ group: "nodes", data: { id, label, tag, props } });
    }
  }

  return elements;
}

// Catppuccin Mocha palette for tag colors
const TAG_COLORS = [
  "#89b4fa", // Blue
  "#a6e3a1", // Green
  "#fab387", // Peach
  "#cba6f7", // Mauve
  "#f38ba8", // Red
  "#89dceb", // Sky
  "#f9e2af", // Yellow
  "#74c7ec", // Sapphire
];

export function tagColor(tag: string | undefined, tagIndex: Map<string, number>): string {
  if (!tag) return "#6c7086"; // Overlay0
  if (!tagIndex.has(tag)) tagIndex.set(tag, tagIndex.size);
  return TAG_COLORS[tagIndex.get(tag)! % TAG_COLORS.length];
}
