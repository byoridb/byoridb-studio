import { useRef, useSyncExternalStore } from "react";

/**
 * The playhead lives outside React so a playing timeline re-renders only the
 * components that draw the current frame (player, playhead, timecode).
 */
let time = 0;
let epoch = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const playbackClock = {
  get: () => time,
  /** Changes only for an explicit seek, never for an ordinary playback frame. */
  epoch: () => epoch,
  /** Advance during playback (or clamp after an edit); not a seek. */
  set(value: number) {
    const next = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (next === time) return;
    time = next;
    emit();
  },
  /** An explicit jump: media elements re-seek even when the time is unchanged. */
  seek(value: number | ((current: number) => number)) {
    const next = typeof value === "function" ? value(time) : value;
    time = Number.isFinite(next) ? Math.max(0, next) : 0;
    epoch++;
    emit();
  },
  subscribe,
};

/** Re-renders on every clock change: only for what draws the current frame. */
export const useClockTime = () => useSyncExternalStore(subscribe, playbackClock.get);

/** Re-renders only when the derived primitive changes (button state, counts). */
export function useClockValue<T extends string | number | boolean | null>(
  select: (time: number) => T,
): T {
  return useSyncExternalStore(subscribe, () => select(time));
}

/** The playhead for panels that must not re-render during playback: it holds still while playing. */
export function useIdleClockTime(playing: boolean) {
  const held = useRef(time);
  return useSyncExternalStore(subscribe, () =>
    playing ? held.current : (held.current = time),
  );
}

/** How often the clock is moved on while no animation frame arrives (a hidden or covered window). */
export const BACKGROUND_TICK_MS = 250;
/** A wrap this late (seconds past the end of a repeat) starts exactly at the range's start. */
const WRAP_SLACK = 0.25;

export interface PlaybackRun {
  /** Where playback stops, in seconds. */
  total: number;
  /** The repeated range right now, if any. */
  loop: () => { start: number; end: number } | null;
  /** True while a media element is buffering: the clock holds, and that time is not played. */
  waiting: () => boolean;
  /** The clock has reached `total` and stopped. */
  onEnd: () => void;
}

/** The running playback's way to move its clock ahead without a seek. */
let skipAhead: ((seconds: number) => void) | null = null;

/**
 * Puts the playing clock this much ahead, from its next step on. For sound that is
 * found to be ahead of the clock: unlike a seek it restarts no media element.
 * Returns whether a playback took it.
 */
export function skipPlaybackAhead(seconds: number) {
  if (!skipAhead || !Number.isFinite(seconds) || seconds <= 0) return false;
  skipAhead(seconds);
  return true;
}

/**
 * Moves the playback clock on until stopped (the function it returns) or the end.
 *
 * The position is where playback was last anchored plus the wall-clock time since
 * (`performance.now`), not a sum of frame intervals. Animation frames only decide
 * how often it is drawn: when they stop arriving because the window is hidden,
 * covered or the screen is locked, a slow timer keeps the clock going, so playback
 * still stops at the end, repeats, and starts and stops each clip's sound; when
 * frames come back the playhead is where the sound is.
 */
export function runPlayback({ total, loop, waiting, onEnd }: PlaybackRun): () => void {
  let stopped = false;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The wall-clock time of the latest step; steps never go back in time. */
  let last = performance.now();
  let anchor = { wall: last, time, epoch };
  /** What this run last put on the clock: anything else was put there by someone else. */
  let shown = time;
  const hold = (now: number) => {
    anchor = { wall: now, time, epoch };
    shown = time;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    clearInterval(timer);
    document.removeEventListener("visibilitychange", background);
    if (skipAhead === skip) skipAhead = null;
  };
  const skip = (seconds: number) => {
    anchor = { ...anchor, time: anchor.time + seconds };
  };
  skipAhead = skip;
  const step = (now: number) => {
    if (stopped || now < last) return;
    last = now;
    // A seek, or a clamp after an edit, moved the playhead: playback goes on from there.
    // So does a wait for buffering: the time spent waiting is not played.
    if (epoch !== anchor.epoch || time !== shown || waiting()) {
      hold(now);
      return;
    }
    const next = anchor.time + (now - anchor.wall) / 1000;
    const repeat = loop();
    if (repeat && next >= repeat.end) {
      const length = repeat.end - repeat.start;
      const over = next - repeat.end;
      // A frame's delay wraps to the start itself; a long gap (a hidden window) keeps
      // its place in the range. That is only for a playhead that ran past the end
      // just now: one that was already past it (a seek beyond the range, or the
      // repeat was turned on for a range behind the playhead) starts the range.
      const ran = shown < repeat.end && over >= WRAP_SLACK && length > 0;
      playbackClock.seek(repeat.start + (ran ? over % length : 0));
      hold(now);
    } else if (next >= total) {
      playbackClock.set(total);
      stop();
      onEnd();
    } else {
      playbackClock.set(next);
      shown = time;
    }
  };
  const animate = (now: number) => {
    step(now);
    if (!stopped) frame = requestAnimationFrame(animate);
  };
  const tick = () => {
    const now = performance.now();
    // Frames are arriving: they move the clock.
    if (document.visibilityState !== "hidden" && now - last < BACKGROUND_TICK_MS - 50) return;
    step(now);
  };
  // Hidden or shown again: the clock is put right at once, before any frame or tick.
  const background = () => step(performance.now());
  frame = requestAnimationFrame(animate);
  timer = setInterval(tick, BACKGROUND_TICK_MS);
  document.addEventListener("visibilitychange", background);
  return stop;
}
