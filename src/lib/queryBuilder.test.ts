import { describe, it, expect } from "vitest";
import { buildMatchQuery, type QueryBuilderSpec } from "./queryBuilder";

function spec(overrides: Partial<QueryBuilderSpec>): QueryBuilderSpec {
  return {
    startTag: "person",
    conditions: [],
    edge: null,
    endTag: "",
    limit: null,
    ...overrides,
  };
}

describe("buildMatchQuery", () => {
  it("returns empty string without a start tag", () => {
    expect(buildMatchQuery(spec({ startTag: "" }))).toBe("");
  });

  it("builds a simple node match", () => {
    expect(buildMatchQuery(spec({}))).toBe("MATCH (a:person) RETURN a");
  });

  it("adds a LIMIT", () => {
    expect(buildMatchQuery(spec({ limit: 100 }))).toBe("MATCH (a:person) RETURN a LIMIT 100");
  });

  it("ignores a non-positive limit", () => {
    expect(buildMatchQuery(spec({ limit: 0 }))).toBe("MATCH (a:person) RETURN a");
  });

  it("renders outgoing / incoming / undirected edges", () => {
    const e = (direction: "out" | "in" | "both") =>
      buildMatchQuery(spec({ edge: { name: "knows", direction }, endTag: "person" }));
    expect(e("out")).toBe("MATCH (a:person)-[e:knows]->(b:person) RETURN a, b");
    expect(e("in")).toBe("MATCH (a:person)<-[e:knows]-(b:person) RETURN a, b");
    expect(e("both")).toBe("MATCH (a:person)-[e:knows]-(b:person) RETURN a, b");
  });

  it("leaves the end node anonymous when no end tag is given", () => {
    expect(buildMatchQuery(spec({ edge: { name: "knows", direction: "out" }, endTag: "" }))).toBe(
      "MATCH (a:person)-[e:knows]->(b) RETURN a, b",
    );
  });

  it("quotes string values and leaves numbers/booleans bare", () => {
    expect(
      buildMatchQuery(spec({ conditions: [{ property: "name", op: "==", value: "Alice" }] })),
    ).toBe('MATCH (a:person) WHERE a.name == "Alice" RETURN a');
    expect(buildMatchQuery(spec({ conditions: [{ property: "age", op: ">", value: "30" }] }))).toBe(
      "MATCH (a:person) WHERE a.age > 30 RETURN a",
    );
    expect(
      buildMatchQuery(spec({ conditions: [{ property: "active", op: "==", value: "true" }] })),
    ).toBe("MATCH (a:person) WHERE a.active == true RETURN a");
  });

  it("joins multiple conditions with AND and skips incomplete ones", () => {
    const q = buildMatchQuery(
      spec({
        conditions: [
          { property: "age", op: ">", value: "25" },
          { property: "", op: "==", value: "x" }, // skipped (no property)
          { property: "name", op: "CONTAINS", value: "li" },
        ],
      }),
    );
    expect(q).toBe('MATCH (a:person) WHERE a.age > 25 AND a.name CONTAINS "li" RETURN a');
  });

  it("escapes quotes inside string values", () => {
    expect(
      buildMatchQuery(spec({ conditions: [{ property: "name", op: "==", value: 'A"B' }] })),
    ).toBe('MATCH (a:person) WHERE a.name == "A\\"B" RETURN a');
  });
});
