import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isNgqlKeyword, NGQL_KEYWORDS, NGQL_DDL, NGQL_DML, NGQL_DQL } from "./ngql-language";

describe("isNgqlKeyword", () => {
  it("returns true for every keyword in NGQL_KEYWORDS (exact case)", () => {
    for (const kw of NGQL_KEYWORDS) {
      expect(isNgqlKeyword(kw)).toBe(true);
    }
  });

  it("returns true for lowercase versions of all keywords", () => {
    for (const kw of NGQL_KEYWORDS) {
      expect(isNgqlKeyword(kw.toLowerCase())).toBe(true);
    }
  });

  it("returns false for non-keyword strings", () => {
    expect(isNgqlKeyword("person")).toBe(false);
    expect(isNgqlKeyword("follows")).toBe(false);
    expect(isNgqlKeyword("")).toBe(false);
    expect(isNgqlKeyword("123")).toBe(false);
  });

  // PBT: case-insensitive invariant
  it("PBT: isNgqlKeyword is case-insensitive for all known keywords", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NGQL_KEYWORDS), (kw) => {
        expect(isNgqlKeyword(kw)).toBe(true);
        expect(isNgqlKeyword(kw.toLowerCase())).toBe(true);
        expect(isNgqlKeyword(kw.toUpperCase())).toBe(true);
        // Mixed case: first char lower, rest upper
        const mixed = kw[0].toLowerCase() + kw.slice(1).toUpperCase();
        expect(isNgqlKeyword(mixed)).toBe(true);
      }),
    );
  });

  // PBT: arbitrary non-keyword strings should not collide with known keywords
  it("PBT: random lowercase alpha strings that are not keywords return false", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,20}$/).filter((s) => !NGQL_KEYWORDS.includes(s.toUpperCase())),
        (nonKeyword) => {
          expect(isNgqlKeyword(nonKeyword)).toBe(false);
        },
      ),
    );
  });
});

describe("keyword sets", () => {
  it("DDL keywords are a subset of NGQL_KEYWORDS", () => {
    for (const kw of NGQL_DDL) {
      expect(NGQL_KEYWORDS).toContain(kw);
    }
  });

  it("DML keywords are a subset of NGQL_KEYWORDS", () => {
    for (const kw of NGQL_DML) {
      expect(NGQL_KEYWORDS).toContain(kw);
    }
  });

  it("DQL keywords are a subset of NGQL_KEYWORDS", () => {
    for (const kw of NGQL_DQL) {
      expect(NGQL_KEYWORDS).toContain(kw);
    }
  });

  it("NGQL_KEYWORDS has no duplicates", () => {
    const unique = new Set(NGQL_KEYWORDS);
    expect(unique.size).toBe(NGQL_KEYWORDS.length);
  });
});
