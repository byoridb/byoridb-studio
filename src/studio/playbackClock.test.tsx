import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { playbackClock, useClockTime, useClockValue, useIdleClockTime } from "./playbackClock";

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
