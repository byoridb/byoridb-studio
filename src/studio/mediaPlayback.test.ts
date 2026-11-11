import { afterEach, expect, it, vi } from "vitest";
import { isPreviewPlaybackWaiting, MediaPlayback, type PlaybackSnapshot } from "./mediaPlayback";

const controllers: MediaPlayback[] = [];
const state: PlaybackSnapshot = { time: 2, target: 7, speed: 1, volume: .8, playing: true, active: true, reverse: false };

function source(ready = 4) {
  const element = document.createElement("audio");
  const media = { ready, seeking: false, paused: true, position: 7 };
  Object.defineProperties(element, {
    readyState: { get: () => media.ready },
    seeking: { get: () => media.seeking },
    paused: { get: () => media.paused },
    currentTime: { get: () => media.position, set: (value: number) => { media.position = value; } },
  });
  const play = vi.spyOn(element, "play").mockImplementation(() => { media.paused = false; return Promise.resolve(); });
  const pause = vi.spyOn(element, "pause").mockImplementation(() => { media.paused = true; });
  const error = vi.fn();
  const transport = new MediaPlayback(element, error);
  controllers.push(transport);
  return { element, media, play, pause, error, transport };
}

// Unlike a plain currentTime field, this decoder keeps advancing independently
// of React/RAF and every seek briefly discards its playable buffer.
function nativeSource(initialPosition = 7.05) {
  const element = document.createElement("audio");
  let base = initialPosition, anchor = performance.now(), rate = 1, volume = 1;
  let muted = false, paused = true, seeking = false, ready = 4;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  const writes = { seeks: [] as number[], rates: 0, volumes: 0, muted: 0 };
  const position = () => base + (!paused && !seeking ? (performance.now() - anchor) / 1000 * rate : 0);
  const retainPosition = () => { base = position(); anchor = performance.now(); };
  Object.defineProperties(element, {
    readyState: { get: () => ready },
    seeking: { get: () => seeking },
    paused: { get: () => paused },
    duration: { get: () => 120 },
    currentTime: {
      get: position,
      set: (value: number) => {
        writes.seeks.push(value);
        base = value; anchor = performance.now(); seeking = true; ready = 2;
        element.dispatchEvent(new Event("seeking"));
        element.dispatchEvent(new Event("waiting"));
        clearTimeout(seekTimer);
        seekTimer = setTimeout(() => {
          seeking = false; ready = 4; anchor = performance.now();
          element.dispatchEvent(new Event("seeked"));
          element.dispatchEvent(new Event("canplay"));
        }, 70);
      },
    },
    playbackRate: {
      get: () => rate,
      set: (value: number) => {
        retainPosition(); rate = value; writes.rates++;
        element.dispatchEvent(new Event("ratechange"));
      },
    },
    volume: { get: () => volume, set: (value: number) => { volume = value; writes.volumes++; } },
    muted: { get: () => muted, set: (value: boolean) => { muted = value; writes.muted++; } },
  });
  const play = vi.spyOn(element, "play").mockImplementation(() => {
    retainPosition(); paused = false;
    return ready >= 3 ? Promise.resolve() : new Promise<void>((resolve) => {
      element.addEventListener("canplay", () => resolve(), { once: true });
    });
  });
  const pause = vi.spyOn(element, "pause").mockImplementation(() => { retainPosition(); paused = true; });
  const error = vi.fn();
  const transport = new MediaPlayback(element, error);
  controllers.push(transport);
  return { element, transport, writes, play, pause, error };
}

afterEach(() => {
  for (const transport of controllers.splice(0)) transport.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("holds the clock until cold audio has metadata, has finished seeking, and actually starts", async () => {
  const clip = source(0);
  let started!: () => void;
  clip.play.mockImplementation(() => new Promise<void>((resolve) => { started = resolve; }));
  clip.media.position = 0;
  clip.transport.update(state);
  expect(isPreviewPlaybackWaiting()).toBe(true);
  clip.media.ready = 1;
  clip.element.dispatchEvent(new Event("loadedmetadata"));
  expect(clip.media.position).toBe(7);
  clip.media.ready = 3;
  clip.media.seeking = true;
  clip.element.dispatchEvent(new Event("canplay"));
  expect(isPreviewPlaybackWaiting()).toBe(true);
  clip.media.seeking = false;
  clip.element.dispatchEvent(new Event("seeked"));
  expect(isPreviewPlaybackWaiting()).toBe(true);
  started();
  await Promise.resolve();
  expect(isPreviewPlaybackWaiting()).toBe(false);
  expect(clip.play).toHaveBeenCalledTimes(1);
});

it("pauses ready layers during another source's buffering and resumes them together", async () => {
  const ready = source(), cold = source(0);
  ready.transport.update(state);
  cold.transport.update(state);
  await Promise.resolve();
  ready.media.position = 7.2;
  expect(isPreviewPlaybackWaiting()).toBe(true);
  expect(ready.pause).toHaveBeenCalledTimes(1);
  expect(ready.media.position).toBe(7.2);
  expect(cold.pause).not.toHaveBeenCalled();
  expect(isPreviewPlaybackWaiting()).toBe(true);
  expect(ready.pause).toHaveBeenCalledTimes(1);
  cold.media.ready = 4;
  cold.element.dispatchEvent(new Event("loadedmetadata"));
  cold.element.dispatchEvent(new Event("canplay"));
  expect(isPreviewPlaybackWaiting()).toBe(true);
  await Promise.resolve();
  expect(isPreviewPlaybackWaiting()).toBe(false);
  expect(ready.play).toHaveBeenCalledTimes(2);
  expect(cold.play).toHaveBeenCalledTimes(1);
  expect(ready.media.paused).toBe(false);
});

it("ignores future, paused, reverse, failed and disposed sources", async () => {
  const future = source(0), paused = source(0), reverse = source(0), broken = source(0), removed = source(0);
  future.transport.update({ ...state, active: false });
  paused.transport.update({ ...state, playing: false });
  reverse.transport.update({ ...state, reverse: true });
  broken.play.mockRejectedValue(new DOMException("unsupported", "NotSupportedError"));
  broken.transport.update(state);
  removed.transport.update(state);
  removed.transport.dispose();
  await Promise.resolve();
  await Promise.resolve();
  expect(broken.error).toHaveBeenCalledOnce();
  expect(isPreviewPlaybackWaiting()).toBe(false);
});

it("reports a stuck source after a bounded wait instead of silently skipping its audio", async () => {
  const cold = source(0);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  cold.play.mockImplementation(() => new Promise<void>(() => {}));
  cold.transport.update(state);
  expect(isPreviewPlaybackWaiting()).toBe(true);
  now = 14999;
  expect(isPreviewPlaybackWaiting()).toBe(true);
  expect(cold.error).not.toHaveBeenCalled();
  now = 15000;
  expect(isPreviewPlaybackWaiting()).toBe(true);
  expect(cold.error).toHaveBeenCalledWith(expect.stringContaining("준비가 지연"));
  expect(cold.pause).toHaveBeenCalledOnce();
  expect(isPreviewPlaybackWaiting()).toBe(false);
});

it("does not let an old play promise release a new playback request", async () => {
  const clip = source();
  const starts: (() => void)[] = [];
  clip.play.mockImplementation(() => new Promise<void>((resolve) => { starts.push(resolve); }));
  clip.transport.update(state);
  clip.transport.update({ ...state, playing: false });
  clip.transport.update(state);
  starts[0]();
  await Promise.resolve();
  expect(isPreviewPlaybackWaiting()).toBe(true);
  starts[1]();
  await Promise.resolve();
  expect(isPreviewPlaybackWaiting()).toBe(false);
});

it("keeps native playback continuous across late RAF frames without seek or rate-write storms", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const clips = [nativeSource(), nativeSource(7.08)];
  for (const clip of clips) clip.transport.update(state);
  expect(isPreviewPlaybackWaiting()).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(isPreviewPlaybackWaiting()).toBe(false);
  const initialPositions = clips.map(({ element }) => element.currentTime);
  let time = state.time, elapsed = 0;
  for (let frame = 0; frame < 1200; frame++) {
    // A delayed renderer frame is not a scrub. Native media keeps its own clock.
    const ms = frame % 120 === 0 ? 300 : 16;
    await vi.advanceTimersByTimeAsync(ms);
    elapsed += ms / 1000;
    expect(isPreviewPlaybackWaiting()).toBe(false);
    time += ms / 1000;
    for (const clip of clips) clip.transport.update({ ...state, time, target: time + 5 });
  }
  clips.forEach((clip, index) => {
    expect(clip.writes.seeks).toEqual([7]);
    expect(clip.writes.rates).toBe(0);
    expect(clip.writes.volumes).toBe(1);
    expect(clip.writes.muted).toBe(0);
    expect(clip.pause).not.toHaveBeenCalled();
    expect(clip.play).toHaveBeenCalledOnce();
    expect(clip.element.currentTime - initialPositions[index]).toBeCloseTo(elapsed, 5);
    expect(clip.error).not.toHaveBeenCalled();
  });
});

it("performs one asynchronous seek for an explicit discontinuity, then runs steadily", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const clip = nativeSource(7);
  clip.transport.update({ ...state, seekEpoch: 0 });
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  clip.transport.update({ ...state, time: 9, target: 14, seekEpoch: 1 });
  expect(clip.writes.seeks).toEqual([14]);
  expect(isPreviewPlaybackWaiting()).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(isPreviewPlaybackWaiting()).toBe(false);
  clip.transport.update({ ...state, time: 9.1, target: 14.1, seekEpoch: 1 });
  expect(clip.writes.seeks).toEqual([14]);
  expect(clip.play).toHaveBeenCalledOnce();
});

it("does not turn a ready peer into a second buffering source when holding the clock", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const peer = nativeSource(7), cold = source(0);
  peer.transport.update(state);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(80);
  cold.transport.update(state);
  await Promise.resolve();
  expect(isPreviewPlaybackWaiting()).toBe(true);
  expect(peer.pause).toHaveBeenCalledOnce();
  expect(peer.element.currentTime).toBeCloseTo(7.08);
  expect(peer.writes.seeks).toEqual([]);
  expect(peer.element.readyState).toBe(4);
  cold.media.ready = 4;
  cold.element.dispatchEvent(new Event("loadedmetadata"));
  cold.element.dispatchEvent(new Event("canplay"));
  expect(isPreviewPlaybackWaiting()).toBe(true);
  await Promise.resolve();
  expect(isPreviewPlaybackWaiting()).toBe(false);
  expect(peer.writes.seeks).toEqual([]);
  expect(peer.play).toHaveBeenCalledTimes(2);
});
