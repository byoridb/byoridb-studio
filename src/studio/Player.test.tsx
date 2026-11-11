import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Player from "./Player";
import { rpc } from "./api";
import { usePreviewFrame } from "./usePreviewFrame";
import { withPreviewDraft } from "./previewDraft";
import type { Clip, Project } from "./types";
import { MediaPlayback, primePreviewPlayback } from "./mediaPlayback";
vi.mock("./api", () => ({
  assetUrl: (id: string) => `http://studio/${id}`,
  rpc: vi.fn(),
}));
vi.mock("./assetCatalog", () => ({ useProjectFonts: vi.fn() }));
const visual: Clip = {
  id: "v",
  kind: "video",
  mediaId: "m",
  trackId: "v",
  name: "Video",
  start: 0,
  duration: 5,
  sourceIn: 0,
  speed: 1,
  reverse: false,
  volume: 0.8,
  fadeIn: 0,
  fadeOut: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  keyframes: [],
};
const audio: Clip = {
  ...visual,
  id: "a",
  kind: "audio",
  trackId: "a",
  mediaId: "sound",
};
const project: Project = {
  id: "p",
  name: "Test",
  revision: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  clips: [visual, audio],
  media: [],
  tracks: [
    {
      id: "v",
      name: "V",
      kind: "video",
      muted: false,
      hidden: false,
      locked: false,
    },
    {
      id: "a",
      name: "A",
      kind: "audio",
      muted: true,
      hidden: false,
      locked: false,
    },
  ],
  markers: [],
  notes: [],
  concept: { audience: "", message: "", appeal: "", direction: "" },
  updatedAt: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("responsive preview", () => {
  it("seeks source media only for an explicit seek, not a delayed playback frame", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    const props = { project: { ...project, clips: [audio] }, time: 1, seekEpoch: 0, playing: true, onTime: vi.fn(), onPlaying: vi.fn(), selectedId: null, onSelect: vi.fn(), onCommand: vi.fn() };
    const { container, rerender } = render(<Player {...props} />);
    const el = container.querySelector("audio")!;
    expect(el.currentTime).toBe(1);
    await act(async () => {});
    rerender(<Player {...props} time={1.4} />);
    expect(el.currentTime).toBe(1);
    rerender(<Player {...props} time={1.4} seekEpoch={1} />);
    expect(el.currentTime).toBe(1.4);
  });

  it("plays local video and audio immediately and preserves track mute / pause", async () => {
    const props = {
      project,
      time: 0,
      playing: true,
      onTime: vi.fn(),
      onPlaying: vi.fn(),
      selectedId: null,
      onSelect: vi.fn(),
      onCommand: vi.fn(),
    };
    const { container, rerender } = render(<Player {...props} />);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    expect(container.querySelector("video")!.volume).toBe(0.8);
    expect(container.querySelector("audio")!.volume).toBe(0);
    fireEvent.click(screen.getByTitle("소리 끄기"));
    expect(container.querySelector("video")!.volume).toBe(0);
    rerender(<Player {...props} playing={false} />);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    await act(async () => {});
  });
  it("keeps future audio elements mounted and primes them silently before their start", async () => {
    const later = { ...audio, id: "later", start: 2, mediaId: "later-sound" };
    const audible = { ...project, clips: [visual, later], tracks: project.tracks.map(t => ({ ...t, muted: false })) };
    const props = { project: audible, time: 0, playing: false, onTime: vi.fn(), onPlaying: vi.fn(), selectedId: null, onSelect: vi.fn(), onCommand: vi.fn() };
    const { container, rerender } = render(<Player {...props} />);
    const el = container.querySelector("audio")!;
    expect(el).not.toBeNull();
    act(() => primePreviewPlayback());
    expect(el.volume).toBe(0);
    await act(async () => {});
    rerender(<Player {...props} playing time={2.1} />);
    expect(container.querySelector("audio")).toBe(el);
    expect(el.volume).toBe(.8);
    await act(async () => {});
  });
  it("preloads upcoming audio without eagerly loading every distant clip", async () => {
    const later = { ...audio, start: 10 };
    const props = { project: { ...project, clips: [later] }, time: 0, playing: false, onTime: vi.fn(), onPlaying: vi.fn(), selectedId: null, onSelect: vi.fn(), onCommand: vi.fn() };
    const { container, rerender } = render(<Player {...props} />);
    const el = container.querySelector("audio")!;
    expect(el.preload).toBe("metadata");
    rerender(<Player {...props} time={8} />);
    expect(container.querySelector("audio")).toBe(el);
    expect(el.preload).toBe("auto");
    await act(async () => {});
  });
  it("hiding a video track leaves its audio playing, matching the export mixer", async () => {
    const hidden = { ...project, tracks: project.tracks.map(t => ({ ...t, hidden: t.id === "v" })) };
    const { container } = render(<Player project={hidden} time={1} playing onTime={vi.fn()} onPlaying={vi.fn()} selectedId={null} onSelect={vi.fn()} onCommand={vi.fn()} />);
    const el = container.querySelector("video")!;
    expect(el.volume).toBe(.8);
    expect(el.parentElement).toHaveStyle({ display: "none" });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });
  it("uses only the rendered preview audio in precise playback", async () => {
    const props = { project, time: 0, playing: true, onTime: vi.fn(), onPlaying: vi.fn(), selectedId: null, onSelect: vi.fn(), onCommand: vi.fn(), playbackUrl: "http://studio/rendered.mp4" };
    const { container, rerender } = render(<Player {...props} />);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLVideoElement>('[data-clip-id="v"]')!.volume).toBe(0);
    expect(container.querySelector<HTMLAudioElement>("audio")!.volume).toBe(0);
    expect(container.querySelector<HTMLVideoElement>(".rendered-preview")!.volume).toBe(1);
    await act(async () => {});
    rerender(<Player {...props} time={.1} />);
    rerender(<Player {...props} time={.2} />);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });
  it("reports a denied audio start instead of advancing silently", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    const onPlaying = vi.fn();
    render(<Player project={{ ...project, clips: [audio] }} time={0} playing onTime={vi.fn()} onPlaying={onPlaying} selectedId={null} onSelect={vi.fn()} onCommand={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("재생");
    expect(onPlaying).toHaveBeenCalledWith(false);
  });
  it("treats an audio asset as sound even if a legacy clip still says video", async () => {
    const legacy: Project = { ...project, clips: [visual], media: [{ id: "m", kind: "audio", name: "Song.mp3", path: "/song.mp3", duration: 5, width: 0, height: 0, hasAudio: true }] };
    const { container } = render(<Player project={legacy} time={0} playing onTime={vi.fn()} onPlaying={vi.fn()} selectedId={null} onSelect={vi.fn()} onCommand={vi.fn()} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("audio")).not.toBeNull();
    await act(async () => {});
  });
  it("waits for metadata to seek and does not repeatedly seek or play while buffering", async () => {
    const el = document.createElement("audio");
    let readyState = 0, clock = 0, position = 0;
    const seeks: number[] = [];
    Object.defineProperty(el, "readyState", { get: () => readyState });
    Object.defineProperty(el, "currentTime", { get: () => position, set: value => { position = value; seeks.push(value); } });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const transport = new MediaPlayback(el, vi.fn());
    const state = { time: 2, target: 7.5, speed: 1.25, volume: .8, playing: true, active: true, reverse: false };
    transport.update(state);
    expect(seeks).toEqual([]);
    readyState = 1;
    el.dispatchEvent(new Event("loadedmetadata"));
    expect(seeks).toEqual([7.5]);
    readyState = 4;
    el.dispatchEvent(new Event("waiting"));
    for (let i = 1; i < 150; i++) {
      clock = i * 16;
      transport.update({ ...state, time: 2 + i * .016, target: 7.5 + i * .02 });
    }
    expect(seeks).toEqual([7.5]);
    expect(el.playbackRate).toBe(1.25);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new Event("canplay"));
    expect(seeks).toEqual([7.5]);
    transport.dispose();
    await act(async () => {});
  });
  it("keeps draft edits out of the authoritative project", () => {
    const next = withPreviewDraft(project, {
      clipId: "v",
      patch: { color: { ...visual.color, saturation: 0 } },
    });
    expect(next.clips[0].color.saturation).toBe(0);
    expect(project.clips[0].color.saturation).toBe(1);
    expect(next.revision).toBe(project.revision);
    expect(withPreviewDraft(project, null)).toBe(project);
  });
  it("coalesces scrubbing to the latest frame and ignores obsolete responses", async () => {
    vi.useFakeTimers();
    let complete: (value: unknown) => void = () => {};
    vi.mocked(rpc).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(rpc).mockResolvedValue({
      assetId: "latest",
      revision: 1,
      projectId: "p",
    });
    const { result, rerender } = renderHook(
      ({ time }) => usePreviewFrame(project, time, 640, true),
      { initialProps: { time: 0 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    rerender({ time: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    rerender({ time: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      complete({ assetId: "obsolete", revision: 1, projectId: "p" });
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith(
      "preview.frame",
      { time: 2, width: 640, expectedRevision: 1 },
      "p",
    );
    expect(result.current?.url).toBe("http://studio/latest");
  });
  it("invalidates an old revision and reuses a cached matching frame", async () => {
    vi.useFakeTimers();
    vi.mocked(rpc).mockResolvedValue({
      assetId: "frame",
      revision: 1,
      projectId: "p",
    });
    const { result, rerender } = renderHook(
      ({ time, revision, width }) =>
        usePreviewFrame({ ...project, revision }, time, width, true),
      { initialProps: { time: 0, revision: 1, width: 640 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current?.url).toBe("http://studio/frame");
    rerender({ time: 1, revision: 1, width: 640 });
    rerender({ time: 0, revision: 1, width: 640 });
    expect(result.current?.url).toBe("http://studio/frame");
    expect(rpc).toHaveBeenCalledTimes(1);
    rerender({ time: 0, revision: 2, width: 640 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current).toBeNull();
    rerender({ time: 0, revision: 1, width: 960 });
    expect(result.current).toBeNull();
  });
});
