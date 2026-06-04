import { describe, it, expect } from "vitest";
import { buildInsertVertex, buildInsertEdge } from "./DataManager";

describe("buildInsertVertex", () => {
  it("builds statement with no properties", () => {
    expect(buildInsertVertex("person", "1", [])).toBe("INSERT VERTEX person () VALUES 1:()");
  });

  it("wraps string values in quotes", () => {
    const stmt = buildInsertVertex("person", "1", [
      { col: "name", val: "Alice" },
      { col: "age", val: "30" },
    ]);
    expect(stmt).toBe("INSERT VERTEX person (name, age) VALUES 1:('Alice', 30)");
  });

  it("passes through already-quoted values", () => {
    const stmt = buildInsertVertex("person", "1", [{ col: "name", val: "'Bob'" }]);
    expect(stmt).toBe("INSERT VERTEX person (name) VALUES 1:('Bob')");
  });

  it("passes through NULL and booleans unquoted", () => {
    const stmt = buildInsertVertex("t", "1", [
      { col: "active", val: "true" },
      { col: "score", val: "NULL" },
    ]);
    expect(stmt).toBe("INSERT VERTEX t (active, score) VALUES 1:(true, NULL)");
  });

  it("skips pairs with empty column names", () => {
    const stmt = buildInsertVertex("person", "1", [
      { col: "", val: "ignored" },
      { col: "name", val: "Alice" },
    ]);
    expect(stmt).toBe("INSERT VERTEX person (name) VALUES 1:('Alice')");
  });
});

describe("buildInsertEdge", () => {
  it("builds edge statement with properties", () => {
    const stmt = buildInsertEdge("follows", "1", "2", [{ col: "since", val: "2020" }]);
    expect(stmt).toBe("INSERT EDGE follows (since) VALUES 1 -> 2:(2020)");
  });

  it("builds edge statement with no properties", () => {
    expect(buildInsertEdge("follows", "1", "2", [])).toBe(
      "INSERT EDGE follows () VALUES 1 -> 2:()",
    );
  });
});
