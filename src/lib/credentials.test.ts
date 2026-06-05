import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionConfig } from "../types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { connectionKey, savePassword, loadPassword, deletePassword } from "./credentials";

const cfg: ConnectionConfig = {
  host: "10.0.0.1",
  port: 19669,
  username: "root",
  password: "secret",
};

describe("connectionKey", () => {
  it("is host:port:username", () => {
    expect(connectionKey(cfg)).toBe("10.0.0.1:19669:root");
  });
});

describe("savePassword", () => {
  beforeEach(() => invokeMock.mockReset());

  it("stores the password under the connection key", async () => {
    invokeMock.mockResolvedValue(undefined);
    await savePassword(cfg);
    expect(invokeMock).toHaveBeenCalledWith("save_password", {
      key: "10.0.0.1:19669:root",
      password: "secret",
    });
  });

  it("does nothing when the password is empty", async () => {
    await savePassword({ ...cfg, password: "" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("loadPassword", () => {
  beforeEach(() => invokeMock.mockReset());

  it("returns the stored password", async () => {
    invokeMock.mockResolvedValue("secret");
    expect(await loadPassword(cfg)).toBe("secret");
  });

  it("returns '' when nothing is stored", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await loadPassword(cfg)).toBe("");
  });
});

describe("deletePassword", () => {
  beforeEach(() => invokeMock.mockReset());

  it("deletes by key", async () => {
    invokeMock.mockResolvedValue(undefined);
    await deletePassword(cfg);
    expect(invokeMock).toHaveBeenCalledWith("delete_password", { key: "10.0.0.1:19669:root" });
  });
});
