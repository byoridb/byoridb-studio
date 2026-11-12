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
