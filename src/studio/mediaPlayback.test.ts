import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clockModule from "./playbackClock";
import {
  DRIFT_SEEK,
  DRIFT_START,
  DRIFT_STOP,
  isPreviewPlaybackWaiting,
  MAX_TRIM,
  MediaPlayback,
  playbackCalibration,
  playbackDiagnostics,
  resetPlaybackCalibration,
  type PlaybackSnapshot,
} from "./mediaPlayback";

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

beforeEach(() => resetPlaybackCalibration());

afterEach(() => {
  for (const transport of controllers.splice(0)) transport.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPlaybackCalibration();
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
  // Started, but neither has moved yet: the clock still waits for the sound.
  expect(isPreviewPlaybackWaiting()).toBe(true);
  ready.media.position += .01;
  cold.media.position += .01;
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
  cold.media.position += .01;
  await vi.advanceTimersByTimeAsync(16);
  expect(isPreviewPlaybackWaiting()).toBe(false);
  expect(peer.writes.seeks).toEqual([]);
  expect(peer.play).toHaveBeenCalledTimes(2);
});

it("plays an element refused outside the play gesture without sound, and restores sound on the next gesture", async () => {
  const { element, play, error, transport } = source();
  const notice = vi.fn();
  (transport as unknown as { onNotice: typeof notice }).onNotice = notice;
  play.mockImplementation(() => element.muted
    ? Promise.resolve()
    : Promise.reject(new DOMException("blocked", "NotAllowedError")));
  transport.update(state);
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(element.muted).toBe(true);
  expect(notice).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  expect(transport.participates()).toBe(true);
  // Later frames keep it muted instead of unmuting it outside a gesture.
  transport.update({ ...state, time: 2.1, target: 7.1 });
  expect(element.muted).toBe(true);
  play.mockImplementation(() => Promise.resolve());
  element.setAttribute("src", "http://studio/sound");
  transport.prime();
  expect(element.muted).toBe(false);
  transport.update({ ...state, time: 2.2, target: 7.2 });
  expect(element.muted).toBe(false);
});

it("still stops when even a muted start is refused", async () => {
  const { play, error, transport } = source();
  play.mockImplementation(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
  transport.update(state);
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(play).toHaveBeenCalledTimes(2);
});

it("plays again after the element ended and the clock seeks back", async () => {
  const { element, media, play, transport } = source();
  transport.update({ ...state, seekEpoch: 0 });
  await Promise.resolve();
  expect(play).toHaveBeenCalledTimes(1);
  media.paused = true;
  element.dispatchEvent(new Event("ended"));
  transport.update({ ...state, time: 0, target: 0, seekEpoch: 1 });
  expect(play).toHaveBeenCalledTimes(2);
  expect(media.position).toBe(0);
});

/**
 * An element as an engine runs it: after `play()`, a seek or (optionally) a rate change
 * the sound takes `delay` seconds to begin, while the reported position may first run on
 * for `falseRun` seconds and then stand still until the sound has caught up (WKWebView).
 * `stagger`: what each successive start takes longer, both to report and to sound.
 * `reportAfter`: a start reports no movement at all for this long, whatever it plays.
 */
function engine(
  tag: "audio" | "video" = "audio",
  { startDelay = 0, seekDelay = 0, rateDelay = 0, falseRun = 0, position = 0, stagger = [] as number[], reportAfter = 0 } = {},
) {
  const element = document.createElement(tag);
  let base = position, anchor = 0, delay = 0, silent = 0, blind = 0, rate = 1, paused = true, volume = 1, starts = 0;
  const writes = { seeks: [] as number[], rates: [] as number[] };
  const since = () => (performance.now() - anchor) / 1000;
  const sound = () => (paused ? base : base + Math.max(0, since() - delay) * rate);
  const reported = () =>
    paused || since() < blind
      ? base
      : Math.max(sound(), base + Math.max(0, Math.min(since() - silent, falseRun)) * rate);
  const restart = (cost: number) => { base = sound(); anchor = performance.now(); delay = cost; silent = 0; blind = 0; };
  Object.defineProperties(element, {
    readyState: { get: () => 4 },
    seeking: { get: () => false },
    paused: { get: () => paused },
    duration: { get: () => 600 },
    volume: { get: () => volume, set: (value: number) => { volume = value; } },
    currentTime: {
      get: reported,
      set: (value: number) => {
        writes.seeks.push(value);
        restart(paused ? 0 : seekDelay);
        base = value;
        element.dispatchEvent(new Event("seeked"));
      },
    },
    playbackRate: {
      get: () => rate,
      set: (value: number) => { restart(paused ? 0 : rateDelay); rate = value; writes.rates.push(value); },
    },
  });
  const play = vi.spyOn(element, "play").mockImplementation(() => {
    if (paused) {
      silent = stagger.length ? stagger[starts++ % stagger.length] : 0;
      anchor = performance.now(); delay = startDelay + silent; blind = reportAfter; paused = false;
    }
    return Promise.resolve();
  });
  vi.spyOn(element, "pause").mockImplementation(() => { base = sound(); paused = true; });
  const error = vi.fn();
  const transport = new MediaPlayback(element, error);
  controllers.push(transport);
  return {
    element, transport, writes, play, error,
    /** Where the sound really is. */
    sound,
    /** Throw the element off by this many seconds (negative: it falls behind). */
    nudge: (seconds: number) => { base += seconds; },
  };
}

type Engine = ReturnType<typeof engine>;

/** The timeline as the app drives it: the clock asks whether to wait, then every element is updated. */
function timeline(clips: Engine[], frameMs = 16) {
  const clock = { time: 0, epoch: 0, playing: false, skipped: [] as number[] };
  // The running clock takes a skip ahead from its next step on.
  vi.spyOn(clockModule, "skipPlaybackAhead").mockImplementation((seconds: number) => {
    clock.time += seconds;
    clock.skipped.push(seconds);
    return true;
  });
  const update = () => {
    for (const clip of clips)
      clip.transport.update({
        time: clock.time, target: clock.time, speed: 1, volume: 1,
        playing: clock.playing, active: true, reverse: false, seekEpoch: clock.epoch,
      });
  };
  return {
    clock,
    /** The play button, from the start of the timeline. */
    async start() {
      clock.time = 0;
      clock.epoch++;
      update();
      clock.playing = true;
      update();
      await Promise.resolve();
    },
    async stop() {
      clock.playing = false;
      update();
      await Promise.resolve();
    },
    /** Frames for this long; returns the largest distance of any sound from the clock in that time. */
    async run(seconds: number) {
      let worst = 0;
      for (let elapsed = 0; elapsed < seconds * 1000; elapsed += frameMs) {
        await vi.advanceTimersByTimeAsync(frameMs);
        if (!isPreviewPlaybackWaiting()) clock.time += frameMs / 1000;
        update();
        for (const clip of clips) worst = Math.max(worst, Math.abs(clock.time - clip.sound()));
      }
      return worst;
    },
    behind: (clip: Engine) => clock.time - clip.sound(),
  };
}

describe("keeping the media on the clock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });

  it("measures an engine's start delay and, from the next start, holds the clock until the sound begins", async () => {
    // WKWebView as measured: the sound begins 0.3 s late while the position first runs on.
    const clip = engine("audio", { startDelay: 0.3, falseRun: 0.385 });
    const line = timeline([clip]);
    await line.start();
    // The first start: the clock runs ahead until the standstill shows, then waits.
    await line.run(0.45);
    expect(line.behind(clip)).toBeGreaterThan(0.25);
    await line.run(0.75);
    expect(Math.abs(line.behind(clip))).toBeLessThanOrEqual(DRIFT_STOP + 0.02);
    await line.run(0.5);
    expect(playbackCalibration().restart).toBeCloseTo(0.3, 2);
    expect(clip.writes.rates).toEqual([]);
    await line.stop();

    for (let start = 0; start < 2; start++) {
      const seeks = clip.writes.seeks.length;
      await line.start();
      // The clock stands still for as long as the engine needs.
      await line.run(0.25);
      expect(line.clock.time).toBe(0);
      await line.run(0.25);
      expect(line.clock.time).toBeGreaterThan(0.15);
      // From then on the sound is where the clock is.
      expect(await line.run(2.5)).toBeLessThanOrEqual(0.03);
      // Only the return to the start was sought, and nothing was re-timed.
      expect(clip.writes.seeks.slice(seeks)).toEqual([0]);
      expect(clip.writes.rates).toEqual([]);
      await line.stop();
    }
    expect(clip.play).toHaveBeenCalledTimes(3);
  });

  it("times the wait from the first movement of the position, which varies from start to start", async () => {
    // WKWebView as measured: 0.03 to 0.11 s until the position moves, then a constant 0.28 s.
    const clip = engine("audio", { startDelay: 0.28, falseRun: 0.385, stagger: [0.03, 0.06, 0.09, 0.04, 0.08] });
    const line = timeline([clip]);
    await line.start();
    await line.run(1.5);
    await line.stop();
    expect(playbackCalibration().afterMove).toBeCloseTo(0.28, 2);
    expect(playbackCalibration().restart).toBeCloseTo(0.31, 2);
    for (let start = 0; start < 4; start++) {
      await line.start();
      await line.run(0.75);
      // A whole delay that is fixed would be off by up to 0.06 s here.
      expect(await line.run(2)).toBeLessThanOrEqual(0.025);
      await line.stop();
    }
    expect(playbackCalibration().afterMove).toBeCloseTo(0.28, 2);
    expect(clip.writes.rates).toEqual([]);
  });

  it("does not wait beyond the usual whole delay when the position moves late and is the sound at once", async () => {
    // Warm starts: the position moves at once, the sound follows 0.3 s later.
    const clip = engine("audio", { startDelay: 0.3, falseRun: 0.385 });
    const line = timeline([clip]);
    for (let start = 0; start < 2; start++) {
      await line.start();
      await line.run(1.5);
      await line.stop();
    }
    const learned = playbackCalibration();
    expect(learned.afterMove).toBeCloseTo(0.3, 2);
    // One start of another kind, as WKWebView now and then makes: nothing reported for
    // 0.34 s, and the position is the sound from there.
    const late = engine("audio", { startDelay: 0.34 });
    clip.transport.dispose();
    const other = timeline([late]);
    await other.start();
    await other.run(0.75);
    // Counted from the movement it would be 0.3 s off.
    expect(await other.run(1.5)).toBeLessThanOrEqual(0.05);
    expect(late.writes.rates).toEqual([]);
    expect(late.writes.seeks).toEqual([]);
    // One such start does not change what is known.
    expect(playbackCalibration().afterMove).toBeCloseTo(learned.afterMove, 3);
    await other.stop();
    // Twice in a row does.
    await other.start();
    await other.run(1.5);
    expect(playbackCalibration().afterMove).toBeLessThanOrEqual(0.02);
  });

  it("opens at the first movement for an engine whose position is the sound", async () => {
    const clip = engine("audio", { startDelay: 0.2 });
    const line = timeline([clip]);
    for (let start = 0; start < 2; start++) {
      await line.start();
      await line.run(0.15);
      expect(line.clock.time).toBe(0);
      expect(await line.run(2)).toBeLessThanOrEqual(0.03);
      await line.stop();
    }
    expect(playbackCalibration().afterMove).toBeLessThanOrEqual(0.02);
    expect(playbackCalibration().restart).toBeCloseTo(0.2, 1);
  });

  it("starts an engine that needs no time without holding the clock noticeably", async () => {
    const clip = engine("audio", { startDelay: 0.03 });
    const line = timeline([clip]);
    for (let start = 0; start < 3; start++) {
      await line.start();
      await line.run(0.1);
      expect(line.clock.time).toBeGreaterThan(0.03);
      expect(await line.run(2)).toBeLessThanOrEqual(0.05);
      await line.stop();
    }
    expect(playbackCalibration().restart).toBeLessThanOrEqual(0.05);
    expect(clip.writes.rates).toEqual([]);
    expect(clip.writes.seeks.filter((value) => value !== 0)).toEqual([]);
  });

  it("keeps the measured delay for the next launch and forgets it on request", async () => {
    const clip = engine("audio", { startDelay: 0.2, falseRun: 0.25 });
    const line = timeline([clip]);
    await line.start();
    await line.run(1.5);
    const stored = JSON.parse(localStorage.getItem("byori-studio.playback-latency.2") ?? "{}") as Record<string, number>;
    expect(stored.restart).toBeCloseTo(0.2, 2);
    expect(stored.afterMove).toBeCloseTo(0.2, 2);
    resetPlaybackCalibration();
    expect(localStorage.getItem("byori-studio.playback-latency.2")).toBeNull();
    expect(playbackCalibration()).toEqual({ restart: 0, afterMove: 0, seek: 0, trimUsable: true });
  });

  it("does not hold the clock for the start delay in a hidden window", async () => {
    const clip = engine("audio", { startDelay: 0.3, falseRun: 0.385 });
    const line = timeline([clip]);
    await line.start();
    await line.run(1.5);
    await line.stop();
    expect(playbackCalibration().restart).toBeCloseTo(0.3, 2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await line.start();
    await line.run(0.064);
    expect(line.clock.time).toBeGreaterThan(0.03);
  });

  it.each(["audio", "video"] as const)(
    "trims the rate of one %s that drifts on its own by at most five percent, then leaves it alone",
    async (tag) => {
      const steady = engine("audio"), drifting = engine(tag);
      // An engine that changes the pitch with the rate is told not to.
      const flagged = document.createElement(tag) as HTMLMediaElement & { preservesPitch: boolean };
      flagged.preservesPitch = false;
      controllers.push(new MediaPlayback(flagged, vi.fn()));
      expect(flagged.preservesPitch).toBe(true);

      const line = timeline([steady, drifting]);
      await line.start();
      await line.run(1.5);
      drifting.nudge(-0.15);
      // Not at once: an offset must last before it is corrected.
      await line.run(0.2);
      expect(drifting.writes.rates).toEqual([]);
      await line.run(4);
      expect(drifting.writes.rates.length).toBeGreaterThan(0);
      for (const rate of drifting.writes.rates) {
        expect(rate).toBeGreaterThanOrEqual(1);
        expect(rate).toBeLessThanOrEqual(1 + MAX_TRIM + 1e-9);
      }
      expect(drifting.element.playbackRate).toBe(1);
      expect(Math.abs(line.behind(drifting))).toBeLessThanOrEqual(DRIFT_STOP + 0.01);
      // The clock did not wait for one element, and its peer was not touched.
      expect(line.clock.time).toBeCloseTo(5.7, 1);
      expect(steady.writes.rates).toEqual([]);
      expect(drifting.writes.seeks).toEqual([]);
      // Hysteresis: what is left is under the threshold and starts nothing new.
      const writes = drifting.writes.rates.length;
      expect(writes).toBeLessThanOrEqual(8);
      expect(await line.run(3)).toBeLessThan(DRIFT_START);
      expect(drifting.writes.rates.length).toBe(writes);
    },
  );

  it("slows an element that runs ahead on its own", async () => {
    const steady = engine("audio"), ahead = engine("audio");
    const line = timeline([steady, ahead]);
    await line.start();
    await line.run(1.5);
    ahead.nudge(0.12);
    await line.run(4);
    expect(Math.min(...ahead.writes.rates)).toBeGreaterThanOrEqual(1 - MAX_TRIM - 1e-9);
    expect(Math.min(...ahead.writes.rates)).toBeLessThan(1);
    expect(ahead.element.playbackRate).toBe(1);
    expect(Math.abs(line.behind(ahead))).toBeLessThanOrEqual(DRIFT_STOP + 0.01);
    expect(ahead.writes.seeks).toEqual([]);
  });

  it("leaves an offset under the threshold alone", async () => {
    const steady = engine("audio"), near = engine("video");
    const line = timeline([steady, near]);
    await line.start();
    await line.run(1.5);
    near.nudge(-(DRIFT_START - 0.02));
    await line.run(3);
    expect(near.writes.rates).toEqual([]);
    expect(near.writes.seeks).toEqual([]);
    expect(line.clock.time).toBeCloseTo(4.5, 1);
  });

  it("seeks an element that is too far off for a rate trim, once", async () => {
    const steady = engine("audio"), far = engine("audio");
    const line = timeline([steady, far]);
    await line.start();
    await line.run(1.5);
    far.nudge(-(DRIFT_SEEK + 0.2));
    await line.run(1);
    expect(far.writes.seeks).toHaveLength(1);
    expect(far.writes.rates).toEqual([]);
    expect(Math.abs(line.behind(far))).toBeLessThanOrEqual(0.03);
    expect(await line.run(3)).toBeLessThanOrEqual(0.03);
    expect(far.writes.seeks).toHaveLength(1);
    expect(steady.writes.seeks).toEqual([]);
  });

  it("seeks ahead by what a seek costs the engine, once that is known", async () => {
    const steady = engine("audio"), far = engine("audio", { seekDelay: 0.2 });
    const line = timeline([steady, far]);
    await line.start();
    await line.run(1.5);
    far.nudge(-0.6);
    // The first corrective seek lands late by the engine's seek delay, which is then measured.
    await line.run(2);
    expect(playbackCalibration().seek).toBeCloseTo(0.2, 1);
    await line.run(6);
    expect(Math.abs(line.behind(far))).toBeLessThanOrEqual(DRIFT_START);
    far.nudge(-0.6);
    const before = far.writes.seeks.length;
    await line.run(1.2);
    // The next one aims ahead and lands on the clock.
    expect(far.writes.seeks.length).toBe(before + 1);
    expect(far.writes.seeks[before]).toBeGreaterThan(line.clock.time - 1.2 + 0.15);
    expect(Math.abs(line.behind(far))).toBeLessThanOrEqual(0.05);
  });

  it("stops trimming on an engine whose rate change costs more than it gains", async () => {
    // WKWebView as measured: a rate change stalls the sound for about 0.4 s.
    const steady = engine("audio"), costly = engine("audio", { rateDelay: 0.4 });
    const line = timeline([steady, costly]);
    await line.start();
    await line.run(1.5);
    costly.nudge(-0.15);
    await line.run(6);
    expect(playbackCalibration().trimUsable).toBe(false);
    const rates = costly.writes.rates.length;
    expect(costly.element.playbackRate).toBe(1);
    expect(Math.abs(line.behind(costly))).toBeLessThanOrEqual(DRIFT_START);
    // From now on an offset is sought, not trimmed.
    costly.nudge(-0.15);
    await line.run(3);
    expect(costly.writes.rates.length).toBe(rates);
    expect(Math.abs(line.behind(costly))).toBeLessThanOrEqual(DRIFT_START);
  });

  it("lets the clock wait when everything that plays falls behind, without touching the engine", async () => {
    const one = engine("audio"), other = engine("video");
    const line = timeline([one, other]);
    await line.start();
    await line.run(1.5);
    one.nudge(-0.2);
    other.nudge(-0.2);
    await line.run(1);
    expect(line.clock.time).toBeCloseTo(2.5 - 0.2, 1);
    expect(Math.abs(line.behind(one))).toBeLessThanOrEqual(DRIFT_STOP + 0.02);
    for (const clip of [one, other]) {
      expect(clip.writes.rates).toEqual([]);
      expect(clip.writes.seeks).toEqual([]);
    }
  });

  it("moves the clock up when everything that plays is ahead of it, without touching the engine", async () => {
    const one = engine("audio"), other = engine("video");
    const line = timeline([one, other]);
    await line.start();
    await line.run(1.5);
    one.nudge(0.15);
    other.nudge(0.15);
    await line.run(1);
    expect(line.clock.skipped).toHaveLength(1);
    expect(line.clock.skipped[0]).toBeCloseTo(0.15, 1);
    expect(Math.abs(line.behind(one))).toBeLessThanOrEqual(0.03);
    expect(await line.run(3)).toBeLessThanOrEqual(0.03);
    expect(line.clock.skipped).toHaveLength(1);
    for (const clip of [one, other]) {
      expect(clip.writes.rates).toEqual([]);
      expect(clip.writes.seeks).toEqual([]);
    }
  });

  it("does not move the clock up to a position that an engine reports ahead of its sound while it starts", async () => {
    const clip = engine("audio", { startDelay: 0.3, falseRun: 0.385 });
    const line = timeline([clip]);
    for (let start = 0; start < 3; start++) {
      await line.start();
      await line.run(2);
      await line.stop();
    }
    expect(line.clock.skipped).toEqual([]);
  });

  it("moves the clock up to a start whose position moved late and far at once", async () => {
    const clip = engine("audio", { startDelay: 0.3, falseRun: 0.385 });
    const line = timeline([clip]);
    for (let start = 0; start < 2; start++) {
      await line.start();
      await line.run(1.5);
      await line.stop();
    }
    clip.transport.dispose();
    // WKWebView now and then: nothing for 0.4 s, the sound already 0.1 s in when it shows.
    const late = engine("audio", { startDelay: 0.3, reportAfter: 0.4 });
    const other = timeline([late]);
    await other.start();
    await other.run(0.5);
    expect(other.behind(late)).toBeLessThan(-0.08);
    await other.run(1);
    expect(other.clock.skipped).toHaveLength(1);
    expect(Math.abs(other.behind(late))).toBeLessThanOrEqual(0.03);
    expect(late.writes.rates).toEqual([]);
    expect(late.writes.seeks).toEqual([]);
  });

  it("chases nothing while the clock moves on the background timer", async () => {
    const steady = engine("audio"), drifting = engine("audio");
    const line = timeline([steady, drifting], 250);
    await line.start();
    await line.run(2);
    drifting.nudge(-0.2);
    await line.run(4);
    expect(drifting.writes.rates).toEqual([]);
    expect(drifting.writes.seeks).toEqual([]);
    expect(line.clock.time).toBeCloseTo(6, 1);
  });

  it("records its decisions only while a diagnosis asks for them", async () => {
    const clip = engine("audio", { startDelay: 0.1 });
    const line = timeline([clip]);
    await line.start();
    await line.run(1.5);
    expect(playbackDiagnostics(true)).toEqual([]);
    await line.stop();
    await line.start();
    await line.run(1.5);
    const recorded = playbackDiagnostics(false).map((entry) => entry.event);
    expect(recorded).toContain("play()");
    expect(recorded).toContain("measured restart delay");
    expect(playbackDiagnostics(false)).toEqual([]);
  });
});
