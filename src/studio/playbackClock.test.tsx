import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_TICK_MS, playbackClock, runPlayback, skipPlaybackAhead, useClockTime, useClockValue, useIdleClockTime } from "./playbackClock";

beforeEach(() => playbackClock.seek(0));

describe("playback clock", () => {
  it("separates playback frames from explicit seeks", () => {
    const epoch = playbackClock.epoch();
    playbackClock.set(1.5);
    expect(playbackClock.get()).toBe(1.5);
    expect(playbackClock.epoch()).toBe(epoch);
    playbackClock.seek((value) => value + 1);
    expect(playbackClock.get()).toBe(2.5);
    expect(playbackClock.epoch()).toBe(epoch + 1);
    playbackClock.seek(2.5);
    expect(playbackClock.epoch()).toBe(epoch + 2);
    playbackClock.set(Number.NaN);
    expect(playbackClock.get()).toBe(0);
    playbackClock.set(-4);
    expect(playbackClock.get()).toBe(0);
  });
  it("re-renders a frame subscriber every tick but a derived subscriber only on change", () => {
    let frames = 0, derived = 0;
    const Frame = () => { frames++; return <i>{useClockTime()}</i>; };
    const Derived = () => { derived++; return <b>{String(useClockValue((time) => time >= 1))}</b>; };
    const { container } = render(<><Frame /><Derived /></>);
    for (let step = 1; step <= 30; step++) act(() => playbackClock.set(step / 20));
    expect(frames).toBe(31);
    expect(derived).toBe(2);
    expect(container.querySelector("b")).toHaveTextContent("true");
  });
  it("holds the playhead still for panels while playing and catches up on pause", () => {
    let renders = 0;
    const { result, rerender } = renderHook(({ playing }) => { renders++; return useIdleClockTime(playing); }, { initialProps: { playing: false } });
    act(() => playbackClock.seek(2));
    expect(result.current).toBe(2);
    rerender({ playing: true });
    const before = renders;
    for (let step = 1; step <= 60; step++) act(() => playbackClock.set(2 + step / 60));
    expect(renders).toBe(before);
    expect(result.current).toBe(2);
    rerender({ playing: false });
    expect(result.current).toBe(3);
  });
});

describe("playback run", () => {
  let visibility: DocumentVisibilityState = "visible";
  const show = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  /** A window that is hidden, covered or locked gets no animation frames. */
  const freezeFrames = () => {
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => pending.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return () => {
      vi.unstubAllGlobals();
      for (const callback of pending.splice(0)) requestAnimationFrame(callback);
    };
  };
  const run = (extra: Partial<Parameters<typeof runPlayback>[0]> = {}) => {
    const onEnd = vi.fn();
    const stop = runPlayback({ total: 10, loop: () => null, waiting: () => false, onEnd, ...extra });
    return { onEnd, stop };
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("follows the wall clock on every animation frame and stops exactly at the end", () => {
    const { onEnd, stop } = run({ total: 2 });
    vi.advanceTimersByTime(1000);
    expect(playbackClock.get()).toBeGreaterThan(0.95);
    expect(playbackClock.get()).toBeLessThanOrEqual(1);
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1100);
    expect(playbackClock.get()).toBe(2);
    expect(onEnd).toHaveBeenCalledOnce();
    // Stopped: nothing moves the clock afterwards.
    playbackClock.seek(0.5);
    vi.advanceTimersByTime(1000);
    expect(playbackClock.get()).toBe(0.5);
    stop();
  });

  it("keeps time by a slow timer while no frame arrives, and is in the right place when frames return", () => {
    const { onEnd, stop } = run();
    vi.advanceTimersByTime(1000);
    const thaw = freezeFrames();
    show("hidden");
    const ticks = vi.fn();
    const unsubscribe = playbackClock.subscribe(ticks);
    vi.advanceTimersByTime(3000);
    // Moved on by the timer alone, a few times a second rather than sixty.
    expect(playbackClock.get()).toBeGreaterThan(4 - BACKGROUND_TICK_MS / 1000 - 0.02);
    expect(playbackClock.get()).toBeLessThanOrEqual(4);
    expect(ticks.mock.calls.length).toBeGreaterThanOrEqual(3000 / BACKGROUND_TICK_MS - 1);
    expect(ticks.mock.calls.length).toBeLessThanOrEqual(3000 / BACKGROUND_TICK_MS + 2);
    unsubscribe();
    // Shown again: the position is the elapsed wall-clock time at once, before any frame.
    vi.advanceTimersByTime(100);
    show("visible");
    expect(playbackClock.get()).toBeCloseTo(4.1, 5);
    thaw();
    vi.advanceTimersByTime(900);
    expect(playbackClock.get()).toBeGreaterThan(4.95);
    expect(playbackClock.get()).toBeLessThanOrEqual(5);
    expect(onEnd).not.toHaveBeenCalled();
    stop();
  });

  it("catches up in one step when even the timer was suspended", () => {
    // A suspended page runs neither frames nor timers: only the wall clock goes on.
    freezeFrames();
    vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const { stop } = run({ total: 60 });
    vi.advanceTimersByTime(20_000);
    expect(playbackClock.get()).toBe(0);
    show("visible");
    expect(playbackClock.get()).toBeCloseTo(20, 5);
    stop();
  });

  it("ends in a hidden window", () => {
    const { onEnd, stop } = run({ total: 2 });
    freezeFrames();
    show("hidden");
    vi.advanceTimersByTime(2000 + BACKGROUND_TICK_MS);
    expect(playbackClock.get()).toBe(2);
    expect(onEnd).toHaveBeenCalledOnce();
    stop();
  });

  it("repeats a range in a hidden window, with an explicit seek for the media elements", () => {
    const { onEnd, stop } = run({ loop: () => ({ start: 1, end: 3 }) });
    playbackClock.seek(1);
    freezeFrames();
    show("hidden");
    const epoch = playbackClock.epoch();
    vi.advanceTimersByTime(5000);
    // Two passes of the two-second range and a little: back near its start, never past its end.
    expect(playbackClock.epoch()).toBeGreaterThanOrEqual(epoch + 2);
    expect(playbackClock.get()).toBeGreaterThanOrEqual(1);
    expect(playbackClock.get()).toBeLessThan(3);
    expect(onEnd).not.toHaveBeenCalled();
    stop();
  });

  it("keeps its place in the repeated range after a long gap", () => {
    freezeFrames();
    vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    playbackClock.seek(10);
    const { stop } = run({ total: 60, loop: () => ({ start: 10, end: 14 }) });
    // 9.5 s later: two whole passes of the four-second range, then 1.5 s into the third.
    vi.advanceTimersByTime(9500);
    show("visible");
    expect(playbackClock.get()).toBeCloseTo(11.5, 5);
    stop();
  });

  it("starts the range after a seek past it, and when a range behind the playhead starts repeating", () => {
    let range: { start: number; end: number } | null = { start: 10, end: 14 };
    playbackClock.seek(10);
    const { stop } = run({ total: 60, loop: () => range });
    vi.advanceTimersByTime(1000);
    // Far past the end: not a place in the range worked out from the distance.
    playbackClock.seek(31);
    vi.advanceTimersByTime(34);
    expect(playbackClock.get()).toBeGreaterThanOrEqual(10);
    expect(playbackClock.get()).toBeLessThan(10.05);
    // Playing on without a repeat, then one is turned on for a range already passed.
    range = null;
    playbackClock.seek(20);
    vi.advanceTimersByTime(10000);
    expect(playbackClock.get()).toBeGreaterThan(29.9);
    range = { start: 10, end: 14 };
    const epoch = playbackClock.epoch();
    vi.advanceTimersByTime(17);
    expect(playbackClock.epoch()).toBe(epoch + 1);
    expect(playbackClock.get()).toBeGreaterThanOrEqual(10);
    expect(playbackClock.get()).toBeLessThan(10.05);
    stop();
  });

  it("does not play the time spent buffering, and goes on from a seek", () => {
    let waiting = false;
    const { stop } = run({ waiting: () => waiting });
    vi.advanceTimersByTime(1000);
    const held = playbackClock.get();
    waiting = true;
    vi.advanceTimersByTime(2000);
    expect(playbackClock.get()).toBe(held);
    waiting = false;
    vi.advanceTimersByTime(1000);
    expect(playbackClock.get()).toBeGreaterThan(held + 0.9);
    expect(playbackClock.get()).toBeLessThanOrEqual(held + 1.02);
    playbackClock.seek(7);
    vi.advanceTimersByTime(500);
    expect(playbackClock.get()).toBeGreaterThan(7.4);
    expect(playbackClock.get()).toBeLessThanOrEqual(7.5);
    stop();
  });

  it("moves ahead to sound that is ahead of it without a seek, only while it runs", () => {
    expect(skipPlaybackAhead(0.2)).toBe(false);
    const { stop } = run();
    vi.advanceTimersByTime(1000);
    const epoch = playbackClock.epoch();
    expect(skipPlaybackAhead(0.2)).toBe(true);
    expect(skipPlaybackAhead(0)).toBe(false);
    expect(skipPlaybackAhead(Number.NaN)).toBe(false);
    vi.advanceTimersByTime(500);
    expect(playbackClock.get()).toBeGreaterThan(1.65);
    expect(playbackClock.get()).toBeLessThanOrEqual(1.7);
    // Not a seek: no media element starts again.
    expect(playbackClock.epoch()).toBe(epoch);
    stop();
    expect(skipPlaybackAhead(0.2)).toBe(false);
  });

  it("stops for good when told to", () => {
    const { stop } = run();
    vi.advanceTimersByTime(500);
    stop();
    const at = playbackClock.get();
    vi.advanceTimersByTime(2000);
    show("hidden");
    expect(playbackClock.get()).toBe(at);
    expect(vi.getTimerCount()).toBe(0);
  });
});
