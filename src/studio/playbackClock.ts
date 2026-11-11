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
