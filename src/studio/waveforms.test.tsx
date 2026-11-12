import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "./api";
import type { Media, Project } from "./types";
import { clearWaveforms, useWaveforms } from "./waveforms";

vi.mock("./api", () => ({ rpc: vi.fn() }));

const sound = (id: string, extra: Partial<Media> = {}): Media => ({
  id, name: id, kind: "audio", path: `/tmp/${id}.wav`, duration: 10, width: 0, height: 0, hasAudio: true, waveformPeaks: 3, ...extra,
});
const project = (media: Media[], used = media.map((item) => item.id), revision = 1) => ({
  id: "p", revision, fps: 30, media,
  clips: used.map((mediaId) => ({ id: `clip-${mediaId}`, kind: "audio", mediaId })),
}) as unknown as Project;
const fetched = () => vi.mocked(rpc).mock.calls.filter(([method]) => method === "media.waveform").map(([, params]) => (params as { id: string }).id);

beforeEach(() => {
  clearWaveforms();
  vi.mocked(rpc).mockReset();
  vi.mocked(rpc).mockImplementation(async (_method, params) => {
    const id = (params as { id: string }).id;
    return { id, waveform: [0.1, 0.2, id === "a" ? 0.3 : 0.9] };
  });
});
afterEach(() => vi.useRealTimers());

it("fetches each waveform once, for the media audio clips play, and keeps it across edits", async () => {
  const media = [sound("a"), sound("b"), sound("unused")];
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project(media, ["a", "b"]) } });
  expect(view.result.current.size).toBe(0);
  await act(async () => {});
  expect(fetched().sort()).toEqual(["a", "b"]);
  expect(rpc).toHaveBeenCalledWith("media.waveform", { id: "a" }, "p");
  expect(view.result.current.get("a")).toEqual([0.1, 0.2, 0.3]);
  expect(view.result.current.get("b")).toEqual([0.1, 0.2, 0.9]);
  // Every edit brings a new project object without the peaks: nothing is fetched again.
  for (let revision = 2; revision < 6; revision++) view.rerender({ value: project(media.map((item) => ({ ...item })), ["a", "b"], revision) });
  await act(async () => {});
  expect(fetched()).toHaveLength(2);
  expect(view.result.current.get("a")).toEqual([0.1, 0.2, 0.3]);
  // A clip that starts to play the third file brings its waveform.
  view.rerender({ value: project(media, ["a", "b", "unused"], 6) });
  await act(async () => {});
  expect(fetched()).toHaveLength(3);
});

it("uses peaks the project still carries, waits for ones not computed, and skips unreadable audio", async () => {
  const media = [
    sound("inline", { waveform: [0.5], waveformPeaks: undefined }),
    sound("pending", { waveformPeaks: undefined }),
    sound("silent", { waveformPeaks: 0 }),
  ];
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project(media) } });
  await act(async () => {});
  expect(fetched()).toEqual([]);
  expect([...view.result.current.keys()]).toEqual(["inline"]);
  // The background worker has filled it in: the poll brings a project that says so.
  view.rerender({ value: project([media[0], sound("pending"), media[2]]) });
  await act(async () => {});
  expect(fetched()).toEqual(["pending"]);
  expect(view.result.current.get("pending")).toEqual([0.1, 0.2, 0.9]);
});

it("fetches again after a relink cleared the waveform, even when the new file has as many peaks", async () => {
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project([sound("a")]) } });
  await act(async () => {});
  expect(view.result.current.get("a")).toEqual([0.1, 0.2, 0.3]);
  vi.mocked(rpc).mockResolvedValue({ id: "a", waveform: [0.7, 0.7, 0.7] });
  view.rerender({ value: project([sound("a", { waveformPeaks: undefined })], ["a"], 2) });
  await act(async () => {});
  expect(view.result.current.has("a")).toBe(false);
  view.rerender({ value: project([sound("a")], ["a"], 2) });
  await act(async () => {});
  expect(fetched()).toHaveLength(2);
  expect(view.result.current.get("a")).toEqual([0.7, 0.7, 0.7]);
});

it("fetches again when the service names other peaks, though this window never saw them cleared", async () => {
  // An agent reprobed the file (replaced by one as long) and the worker refilled
  // the waveform between two polls: same path, length and number of peaks.
  vi.mocked(rpc).mockResolvedValue({ id: "a", waveform: [0.1, 0.2, 0.3], waveformId: "one" });
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project([sound("a", { waveformId: "one" })]) } });
  await act(async () => {});
  expect(view.result.current.get("a")).toEqual([0.1, 0.2, 0.3]);
  vi.mocked(rpc).mockResolvedValue({ id: "a", waveform: [0.9, 0.9, 0.9], waveformId: "two" });
  view.rerender({ value: project([sound("a", { waveformId: "one" })], ["a"], 2) });
  await act(async () => {});
  expect(fetched()).toHaveLength(1);
  view.rerender({ value: project([sound("a", { waveformId: "two" })], ["a"], 2) });
  expect(view.result.current.has("a")).toBe(false);
  await act(async () => {});
  expect(fetched()).toHaveLength(2);
  expect(view.result.current.get("a")).toEqual([0.9, 0.9, 0.9]);
});

it("does not draw old peaks after a reprobe that happened while no audio clip used the file", async () => {
  vi.mocked(rpc).mockResolvedValue({ id: "a", waveform: [0.1, 0.2, 0.3], waveformId: "one" });
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project([sound("a", { waveformId: "one" })]) } });
  await act(async () => {});
  // The clip is deleted, the file reprobed (cleared, then computed again), the clip added back.
  view.rerender({ value: project([sound("a", { waveformId: "one" })], [], 2) });
  view.rerender({ value: project([sound("a", { waveformPeaks: undefined })], [], 3) });
  vi.mocked(rpc).mockResolvedValue({ id: "a", waveform: [0.9, 0.9, 0.9], waveformId: "two" });
  view.rerender({ value: project([sound("a", { waveformId: "two" })], ["a"], 4) });
  await act(async () => {});
  expect(fetched()).toHaveLength(2);
  expect(view.result.current.get("a")).toEqual([0.9, 0.9, 0.9]);
});

it("keeps peaks computed anew since the project was read for the project that names them", async () => {
  // The reply is already the new file's; the project in hand still names the old peaks.
  vi.mocked(rpc).mockResolvedValue({ id: "a", waveform: [0.9, 0.9, 0.9], waveformId: "two" });
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project([sound("a", { waveformId: "one" })]) } });
  await act(async () => {});
  await act(async () => {});
  // Not drawn under the old name, and not asked for over and over.
  expect(view.result.current.has("a")).toBe(false);
  expect(fetched()).toHaveLength(1);
  view.rerender({ value: project([sound("a", { waveformId: "two" })], ["a"], 2) });
  expect(view.result.current.get("a")).toEqual([0.9, 0.9, 0.9]);
  await act(async () => {});
  expect(fetched()).toHaveLength(1);
});

it("asks again a little later when the request failed", async () => {
  vi.useFakeTimers();
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  const view = renderHook(({ value }) => useWaveforms(value), { initialProps: { value: project([sound("a")]) } });
  await act(async () => {});
  expect(view.result.current.size).toBe(0);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetched()).toHaveLength(2);
  expect(view.result.current.get("a")).toEqual([0.1, 0.2, 0.3]);
});
