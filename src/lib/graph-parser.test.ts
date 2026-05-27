import { describe, it, expect } from "vitest";
import { parseGraphElements, tagColor } from "./graph-parser";

describe("parseGraphElements", () => {
  it("returns empty array for empty result", () => {
    expect(parseGraphElements({ columns: [], rows: [], executionTime: 0 })).toEqual([]);
  });

  it("parses edge rows with _src/_dst", () => {
    const result = {
      columns: ["_src", "_dst"],
      rows: [{ _src: "1", _dst: "2" }],
      executionTime: 0,
    };
    const els = parseGraphElements(result);
    const edges = els.filter((e) => e.group === "edges");
    const nodes = els.filter((e) => e.group === "nodes");
    expect(edges).toHaveLength(1);
    expect(nodes).toHaveLength(2);
    expect(edges[0].data.source).toBe("1");
    expect(edges[0].data.target).toBe("2");
  });

  it("parses node rows with id column", () => {
    const result = {
      columns: ["id", "name"],
      rows: [{ id: "42", name: "alice" }],
      executionTime: 0,
    };
    const els = parseGraphElements(result);
    expect(els).toHaveLength(1);
    expect(els[0].group).toBe("nodes");
    expect(els[0].data.id).toBe("42");
    expect(els[0].data.label).toBe("alice");
  });

  it("deduplicates nodes", () => {
    const result = {
      columns: ["_src", "_dst"],
      rows: [
        { _src: "1", _dst: "2" },
        { _src: "1", _dst: "3" },
      ],
      executionTime: 0,
    };
    const nodes = parseGraphElements(result).filter((e) => e.group === "nodes");
    expect(nodes).toHaveLength(3); // 1, 2, 3
  });
});

describe("tagColor", () => {
  it("returns a consistent color for the same tag", () => {
    const idx = new Map<string, number>();
    const c1 = tagColor("person", idx);
    const c2 = tagColor("person", idx);
    expect(c1).toBe(c2);
  });

  it("returns different colors for different tags", () => {
    const idx = new Map<string, number>();
    const c1 = tagColor("person", idx);
    const c2 = tagColor("follows", idx);
    expect(c1).not.toBe(c2);
  });

  it("returns fallback color for undefined tag", () => {
    const idx = new Map<string, number>();
    expect(tagColor(undefined, idx)).toBe("#6c7086");
  });
});
