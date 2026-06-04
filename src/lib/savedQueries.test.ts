import { describe, it, expect, beforeEach } from "vitest";
import type { SavedQuery } from "../types";
import {
  addSavedQuery,
  removeSavedQuery,
  loadSavedQueries,
  persistSavedQueries,
  MAX_SAVED_QUERIES,
} from "./savedQueries";

function sq(name: string, query = "MATCH (n) RETURN n", id = name): SavedQuery {
  return { id, name, query, createdAt: 1 };
}

describe("addSavedQuery", () => {
  it("prepends the newest entry", () => {
    const list = addSavedQuery([sq("a")], sq("b"));
    expect(list.map((q) => q.name)).toEqual(["b", "a"]);
  });

  it("replaces an existing entry with the same name (case-insensitive)", () => {
    const list = addSavedQuery([sq("Daily", "old", "1")], sq("daily", "new", "2"));
    expect(list).toHaveLength(1);
    expect(list[0].query).toBe("new");
    expect(list[0].id).toBe("2");
  });

  it("caps the list at MAX_SAVED_QUERIES", () => {
    let list: SavedQuery[] = [];
    for (let i = 0; i < MAX_SAVED_QUERIES + 10; i++) {
      list = addSavedQuery(list, sq(`q${i}`, "x", `${i}`));
    }
    expect(list).toHaveLength(MAX_SAVED_QUERIES);
  });
});

describe("removeSavedQuery", () => {
  it("removes by id", () => {
    const list = removeSavedQuery([sq("a", "x", "1"), sq("b", "x", "2")], "1");
    expect(list.map((q) => q.id)).toEqual(["2"]);
  });
});

describe("load/persist", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through localStorage", () => {
    persistSavedQueries([sq("a", "x", "1")]);
    expect(loadSavedQueries()).toEqual([sq("a", "x", "1")]);
  });

  it("returns [] when storage is empty or corrupt", () => {
    expect(loadSavedQueries()).toEqual([]);
    localStorage.setItem("byoridb-studio-favorites", "{not json");
    expect(loadSavedQueries()).toEqual([]);
  });
});
