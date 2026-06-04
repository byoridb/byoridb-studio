import { describe, it, expect, beforeEach } from "vitest";
import { t, setLocale, getLocale } from "./i18n";

beforeEach(() => {
  setLocale("en");
});

describe("i18n", () => {
  it("returns English by default", () => {
    expect(getLocale()).toBe("en");
    expect(t("app.connect")).toBe("Connect");
  });

  it("switches to Korean", () => {
    setLocale("ko");
    expect(getLocale()).toBe("ko");
    expect(t("app.connect")).toBe("연결");
    expect(t("sidebar.schema")).toBe("스키마");
  });

  it("falls back to English for unknown locale", () => {
    setLocale("en");
    expect(t("result.rows")).toBe("rows");
  });

  it("returns key for unknown translation key", () => {
    expect(t("unknown.key")).toBe("unknown.key");
  });
});
