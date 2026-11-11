import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
it.each([
  ["", "http://127.0.0.1:43123/session"],
  ["45999", "http://127.0.0.1:45999/session"],
])("connects the browser to the service port from VITE_STUDIO_PORT (%s)", async (port, url) => {
  vi.stubEnv("VITE_STUDIO_PORT", port);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ url: "http://service", token: "t" }) });
  vi.stubGlobal("fetch", fetchMock);
  const { connectStudio } = await import("./api");
  await expect(connectStudio()).resolves.toEqual({ url: "http://service", token: "t" });
  expect(fetchMock).toHaveBeenCalledWith(url);
});
