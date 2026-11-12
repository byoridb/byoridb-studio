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
it("asks the editor for projects without waveforms, and nothing else for them", async () => {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith("/session") ? { url: "http://service", token: "t" } : { result: {} }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  const { rpc } = await import("./api");
  const sent = async (method: string, params?: Record<string, unknown>) => {
    await rpc(method, params, "p");
    const calls = fetchMock.mock.calls as unknown as [string, { body: string }][];
    return JSON.parse(calls[calls.length - 1][1].body);
  };
  expect(await sent("project.get", { ifRevision: 3 })).toEqual({ method: "project.get", params: { ifRevision: 3, omitWaveforms: true }, projectId: "p" });
  expect((await sent("edit.batch", { commands: [], expectedRevision: 3 })).params).toEqual({ commands: [], expectedRevision: 3, omitWaveforms: true });
  expect((await sent("history.undo")).params).toEqual({ omitWaveforms: true });
  expect((await sent("media.import", { paths: ["/a.mp4"] })).params.omitWaveforms).toBe(true);
  // The peaks themselves, and everything the editor does not answer, go as they are.
  expect((await sent("media.waveform", { id: "m" })).params).toEqual({ id: "m" });
  for (const method of ["preview.frame", "preview.cancel", "export.status", "runtime.status", "agent.start", "speech.status", "storage.usage", "memory.search"])
    expect((await sent(method, { id: "x" })).params).toEqual({ id: "x" });
});
