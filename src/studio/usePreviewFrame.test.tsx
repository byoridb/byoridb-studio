import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "./api";
import type { Project } from "./types";
import { usePreviewFrame } from "./usePreviewFrame";

vi.mock("./api", () => ({ rpc: vi.fn(), assetUrl: (id: string) => `asset:${id}` }));

const project = {
  id: "p",
  revision: 3,
  fps: 30,
  width: 1920,
  height: 1080,
  media: [],
  tracks: [],
  markers: [],
  clips: [{ id: "c", start: 0, duration: 4 }],
} as unknown as Project;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(rpc).mockReset();
});
afterEach(() => vi.useRealTimers());

it("stops a frame the service is still rendering when the frame is no longer wanted", async () => {
  let answer: (value: unknown) => void = () => {};
  vi.mocked(rpc).mockImplementation((method) =>
    method === "preview.frame"
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : Promise.resolve({ cancelled: 1 }),
  );
  const view = renderHook(({ enabled }) => usePreviewFrame(project, 1, 640, enabled), {
    initialProps: { enabled: true },
  });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(rpc).toHaveBeenCalledWith("preview.frame", expect.objectContaining({ client: "player" }), "p");
  // Playback starts while the render is running.
  view.rerender({ enabled: false });
  expect(rpc).toHaveBeenCalledWith("preview.cancel", { client: "player" }, "p");
  await act(async () => answer({ assetId: "frame", revision: 3, projectId: "p" }));
  vi.mocked(rpc).mockClear();
  // Nothing in flight any more: pausing and playing again cancels nothing.
  view.rerender({ enabled: true });
  view.rerender({ enabled: false });
  expect(rpc).not.toHaveBeenCalledWith("preview.cancel", expect.anything(), expect.anything());
});

it("stays quiet when a frame is cancelled, in the old form (400) and the new one (200)", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const replies: (() => Promise<unknown>)[] = [
    () => Promise.reject(new Error("더 새로운 미리보기 요청으로 대체되었습니다. (PREVIEW_CANCELLED)")),
    () => Promise.resolve({ cancelled: true }),
    () => Promise.resolve({ assetId: "frame-3", revision: 3, projectId: "p", proxies: 2 }),
  ];
  vi.mocked(rpc).mockImplementation(() => replies.shift()!());
  const view = renderHook(({ time }) => usePreviewFrame(project, time, 640, true), { initialProps: { time: 1 } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(view.result.current).toBeNull();
  view.rerender({ time: 2 });
  await act(() => vi.advanceTimersByTimeAsync(150));
  // Neither a frame nor an error: the picture drawn locally stays.
  expect(view.result.current).toBeNull();
  view.rerender({ time: 3 });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(view.result.current).toMatchObject({ url: "asset:frame-3", proxies: 2 });
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

it("takes no picture from a reply marked cancelled, even one that names a frame, and does not keep it", async () => {
  const replies: unknown[] = [
    { cancelled: true, reason: "stale", assetId: "half-drawn", revision: 3, projectId: "p" },
    { assetId: "frame-1", revision: 3, projectId: "p" },
  ];
  vi.mocked(rpc).mockImplementation(() => Promise.resolve(replies.shift()));
  const view = renderHook(({ time }) => usePreviewFrame(project, time, 640, true), { initialProps: { time: 1 } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(view.result.current).toBeNull();
  // Away and back to the same frame: it was not cached, so it is asked for again.
  view.rerender({ time: 2 });
  view.rerender({ time: 1 });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(view.result.current).toMatchObject({ url: "asset:frame-1" });
  expect(vi.mocked(rpc).mock.calls.filter(([method]) => method === "preview.frame")).toHaveLength(2);
});

it("ignores a service that has no preview.cancel", async () => {
  const unhandled = vi.fn();
  window.addEventListener("unhandledrejection", unhandled);
  vi.mocked(rpc).mockImplementation((method) =>
    method === "preview.cancel" ? Promise.reject(new Error("알 수 없는 메서드입니다: preview.cancel")) : new Promise(() => {}),
  );
  const view = renderHook(({ enabled }) => usePreviewFrame(project, 1, 640, enabled), { initialProps: { enabled: true } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  view.rerender({ enabled: false });
  await act(() => vi.advanceTimersByTimeAsync(50));
  window.removeEventListener("unhandledrejection", unhandled);
  expect(rpc).toHaveBeenCalledWith("preview.cancel", { client: "player" }, "p");
  expect(unhandled).not.toHaveBeenCalled();
  expect(view.result.current).toBeNull();
});

it("asks for the originals only when told to, and keeps the two pictures apart", async () => {
  vi.mocked(rpc).mockImplementation(async (_method, params) =>
    (params as { proxy?: boolean }).proxy === false
      ? { assetId: "original", revision: 3, projectId: "p", proxies: 0 }
      : { assetId: "light", revision: 3, projectId: "p", proxies: 1 },
  );
  const view = renderHook(({ originals }) => usePreviewFrame(project, 1, 640, true, "player", originals), {
    initialProps: { originals: false },
  });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(vi.mocked(rpc).mock.calls[0][1]).not.toHaveProperty("proxy");
  expect(view.result.current).toMatchObject({ url: "asset:light", proxies: 1 });
  view.rerender({ originals: true });
  // The proxy frame is not shown as if it were the original.
  expect(view.result.current).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(rpc).toHaveBeenLastCalledWith("preview.frame", expect.objectContaining({ proxy: false }), "p");
  expect(view.result.current).toMatchObject({ url: "asset:original", proxies: 0 });
  // Back to the proxy frame without another request: it is still cached.
  view.rerender({ originals: false });
  expect(view.result.current).toMatchObject({ url: "asset:light", proxies: 1 });
  expect(rpc).toHaveBeenCalledTimes(2);
});
