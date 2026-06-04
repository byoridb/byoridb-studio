import { describe, it, expect } from "vitest";
import { validateNgql } from "./ngql-validate";
import { entityBeforeDot } from "./ngql-language";

describe("validateNgql — reserved entity names", () => {
  it("flags a reserved word used as a tag name", () => {
    const markers = validateNgql("CREATE TAG tag (name STRING)");
    expect(markers).toHaveLength(1);
    expect(markers[0].message).toContain('"tag"');
    expect(markers[0].severity).toBe("warning");
    // "tag" starts at column 12 (1-based) in "CREATE TAG tag ..."
    expect(markers[0].startColumn).toBe(12);
    expect(markers[0].endColumn).toBe(15);
  });

  it("flags reserved EDGE and SPACE names", () => {
    expect(validateNgql("CREATE EDGE edge (since INT64)")).toHaveLength(1);
    expect(validateNgql("CREATE SPACE order (vid_type = INT64)")).toHaveLength(1);
  });

  it("allows backtick-quoted reserved names", () => {
    expect(validateNgql("CREATE TAG `tag` (name STRING)")).toHaveLength(0);
  });

  it("does not flag non-reserved names", () => {
    expect(validateNgql("CREATE TAG person (name STRING)")).toHaveLength(0);
  });

  it("handles IF NOT EXISTS", () => {
    expect(validateNgql("CREATE TAG IF NOT EXISTS edge (x INT64)")).toHaveLength(1);
    expect(validateNgql("CREATE TAG IF NOT EXISTS person (x INT64)")).toHaveLength(0);
  });

  it("flags reserved names on ALTER and DROP too", () => {
    expect(validateNgql("DROP TAG edge")).toHaveLength(1);
    expect(validateNgql("ALTER TAG order ADD (x INT64)")).toHaveLength(1);
  });
});

describe("validateNgql — reserved property names", () => {
  it("flags a reserved word used as a property name", () => {
    const markers = validateNgql("CREATE TAG person (order INT64, name STRING)");
    expect(markers).toHaveLength(1);
    expect(markers[0].message).toContain('"order"');
    expect(markers[0].message).toContain("property");
  });

  it("flags multiple reserved properties", () => {
    const markers = validateNgql("CREATE EDGE knows (from INT64, over INT64)");
    // "from" and "over" are both reserved keywords.
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag normal property names", () => {
    expect(validateNgql("CREATE TAG person (name STRING, age INT64)")).toHaveLength(0);
  });

  it("computes line/column across multiple lines", () => {
    const text = "USE g;\nCREATE TAG tag (name STRING)";
    const markers = validateNgql(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].line).toBe(2);
  });
});

describe("entityBeforeDot", () => {
  it("returns the entity token before a trailing dot", () => {
    expect(entityBeforeDot("MATCH (n:person) RETURN person.")).toBe("person");
    expect(entityBeforeDot("FETCH PROP ON person 1 YIELD person.")).toBe("person");
  });

  it("returns null when there is no trailing entity-dot", () => {
    expect(entityBeforeDot("MATCH (n:person) RETURN n")).toBeNull();
    expect(entityBeforeDot("")).toBeNull();
    expect(entityBeforeDot("SELECT ")).toBeNull();
  });
});
