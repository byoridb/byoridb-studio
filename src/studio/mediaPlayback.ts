/** Native media transport shared by source clips and the rendered preview. */
import { skipPlaybackAhead } from "./playbackClock";

export interface PlaybackSnapshot {
  time: number;
  target: number;
  speed: number;
  volume: number;
  playing: boolean;
  active: boolean;
  reverse: boolean;
  /** Changes only for an explicit seek, never for an ordinary playback frame. */
  seekEpoch?: number;
}

const transports = new Set<MediaPlayback>();
let priming = false;
const PREVIEW_READY_TIMEOUT_MS = 15000;

/**
 * Keeping the media on the playback clock.
 *
 * An engine does not start a sound the moment `play()` resolves, and a seek or a rate
 * change costs it time again: in WKWebView about 0.3 s for a start, 0.5 s for a seek
 * while playing and 0.4 s for a rate change, during which `currentTime` first runs on as
 * if nothing happened and then stands still; in Chromium a few hundredths. So:
 *
 * - a start of the whole timeline holds the clock until every element moves and the
 *   learned start delay has passed. The delay is measured on every start, a second after
 *   it: the time since, less what the element has played. WKWebView usually needs 0.03
 *   to 0.11 s to move the position and a constant 0.29 s from there, 0.31 to 0.39 s in
 *   all; now and then the position moves only after 0.2 to 0.4 s and is the sound sooner.
 *   So the wait is counted from the first movement, bounded by the usual whole delay.
 *   Both are kept between launches: only the very first start runs ahead of its sound;
 * - while everything that plays is behind the clock, the clock waits for it (no engine
 *   operation, so nothing is heard);
 * - one element off on its own is trimmed by at most five percent of its rate, or, when
 *   it is far off or the engine proved that a rate change costs more than it gains,
 *   seeks to where the clock will be once the seek has taken its time.
 *
 * All offsets are timeline seconds; positive means the media is behind the clock.
 */
/** An offset this large is corrected; one this small ends the correction. */
export const DRIFT_START = 0.08;
export const DRIFT_STOP = 0.02;
/** Beyond this a rate trim would take too long: seek. */
export const DRIFT_SEEK = 0.3;
/** The largest rate trim; with `preservesPitch` it is not heard. */
export const MAX_TRIM = 0.05;
/** How long an offset must last before the clock waits for it, or an element is corrected. */
const LAG_SUSTAIN_MS = 100;
const DRIFT_SUSTAIN_MS = 300;
/** The clock does not wait longer than this for media that falls behind while it plays. */
const LAG_HOLD_LIMIT_MS = 2000;
const LAG_HOLD_PAUSE_MS = 3000;
/** After the clock skipped ahead to the media it does not do so again this long. */
const LEAD_PAUSE_MS = 1000;
/** After a start, a seek or a correction the reported position is not trusted this long. */
const SETTLE_MS = 1000;
/** A started element that reports no movement this long no longer holds the clock. */
const PROGRESS_TIMEOUT_MS = 1000;
/** A corrective seek that takes longer than this is ordinary buffering. */
const CORRECTION_LIMIT_MS = 1500;
/** Offsets are judged only while the clock is drawn every frame, not on the background timer. */
const FREQUENT_MS = 100;
/** A rate change that moved the offset this much the wrong way within a second cost more than it gave. */
const TRIM_HARM = 0.1;
const MAX_LATENCY = 0.8;
/** A lead smaller than this is not worth a seek. */
const MIN_LEAD = 0.03;

/** A measured delay counts once two readings this far apart agree: the element runs at its rate. */
const PROBE_GAP_MS = 150;
const PROBE_AGREE = 0.015;
const STORE_KEY = "byori-studio.playback-latency.2";
/** A start is not waited for longer than its usual whole delay and this. */
const START_MARGIN = 0.03;
/** A measurement this far from what is known is believed only when the next one agrees. */
const OUTLIER = 0.08;

type Restart = "restart" | "seek";
type Measured = Restart | "afterMove";
const MEASURED = ["restart", "afterMove", "seek"] as const;
/**
 * What this engine was measured to need (seconds; 0 while unknown): `restart` from
 * `play()` to the sound, `afterMove` from the first movement of the position to the
 * sound, `seek` from a seek to the sound.
 */
const calibration = { restart: 0, afterMove: 0, seek: 0, trimUsable: true };
const doubted: Record<Measured, number | null> = { restart: null, afterMove: null, seek: null };
try {
  const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<Record<Measured, unknown>> | null;
  for (const kind of MEASURED) {
    const value = stored?.[kind];
    if (typeof value === "number" && value > 0 && value <= MAX_LATENCY) calibration[kind] = value;
  }
} catch { /* no storage, or not ours: measured again */ }
let lagOverSince: number | null = null;
let lagHold: { since: number } | null = null;
let lagHoldBlockedUntil = 0;
let leadOverSince: number | null = null;
let leadBlockedUntil = 0;
let lastPoll = 0;
let previousPollWaited = true;

/** What the transport decided and when, kept only while a diagnosis asks for it. */
let diagnostics: { atMs: number; event: string; value?: number }[] | null = null;
const record = (event: string, value?: number) => {
  if (diagnostics && diagnostics.length < 400)
    diagnostics.push({ atMs: Math.round(performance.now()), event, value: value === undefined ? undefined : Math.round(value * 1000) / 1000 });
};

/** Start (or stop, with `false`) recording the transport's decisions; returns what was recorded. */
export function playbackDiagnostics(enabled = true) {
  const recorded = diagnostics ?? [];
  diagnostics = enabled ? [] : null;
  return recorded;
}

/** What was learned about the engine (seconds), for diagnosis and tests. */
export function playbackCalibration() {
  return { ...calibration };
}

/** Forget what was learned (tests). */
export function resetPlaybackCalibration() {
  for (const kind of MEASURED) {
    calibration[kind] = 0;
    doubted[kind] = null;
  }
  calibration.trimUsable = true;
  try { localStorage.removeItem(STORE_KEY); } catch { /* nothing was kept */ }
  lagOverSince = null;
  lagHold = null;
  lagHoldBlockedUntil = 0;
  leadOverSince = null;
  leadBlockedUntil = 0;
  lastPoll = 0;
  previousPollWaited = true;
}

/** `delay`: how long the engine really took, as measured on one start or seek. */
function learn(kind: Measured, delay: number) {
  record(`measured ${kind} delay`, delay);
  // Not a start delay: something else kept the media.
  if (!Number.isFinite(delay) || delay > 1.5 * MAX_LATENCY || delay < -0.2) return;
  const measured = Math.max(0, Math.min(MAX_LATENCY, delay));
  const known = calibration[kind];
  if (known === 0) calibration[kind] = measured;
  else if (Math.abs(measured - known) <= OUTLIER) {
    // Starts differ by a few hundredths: follow them halfway.
    calibration[kind] = known + (measured - known) / 2;
    doubted[kind] = null;
  } else if (doubted[kind] !== null && Math.abs(measured - doubted[kind]) <= OUTLIER) {
    // Twice in a row: the engine has changed.
    calibration[kind] = measured;
    doubted[kind] = null;
  } else {
    // One start that went differently (an engine now and then starts another way).
    doubted[kind] = measured;
    return;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(MEASURED.map((key) => [key, calibration[key]]))));
  } catch { /* measured again next time */ }
}

/** What a seek while playing costs; until that is known, what a start costs. */
const seekLatency = () => calibration.seek || calibration.restart;

/** Call synchronously from the play click/keyboard gesture, before updating React state. */
export function primePreviewPlayback() {
  if (priming) return;
  priming = true;
  queueMicrotask(() => { priming = false; });
  for (const transport of transports) transport.prime();
}

/** Keep the timeline at its current frame until every active source can play it. */
export function isPreviewPlaybackWaiting() {
  const active = [...transports].filter((transport) => transport.participates());
  const buffering = active.some((transport) => transport.needsData());
  if (buffering) {
    // Pause ready peers without seeking them. A corrective seek would discard
    // their ready decoder buffers and create another round of global waiting.
    for (const transport of active)
      if (!transport.needsData()) transport.holdForClock(true);
  } else {
    for (const transport of transports) transport.holdForClock(false);
  }
  const now = performance.now();
  const frequent = now - lastPoll < FREQUENT_MS;
  lastPoll = now;
  // Visit every source, including after one waits, to maintain bounded timers.
  const waiting = active.map((transport) => transport.waitingForClock(now)).some(Boolean);
  const frozen = previousPollWaited;
  previousPollWaited = waiting;
  if (waiting || !active.length) {
    lagOverSince = null;
    lagHold = null;
    leadOverSince = null;
    return waiting;
  }
  // What everything that plays has in common is the clock's to absorb.
  const lags = active
    .map((transport) => transport.lag(now, frozen || !!lagHold))
    .filter((value): value is number => value !== null);
  const common = lags.length ? Math.min(...lags) : 0;
  if (lagHold) {
    const held = now - lagHold.since;
    const gaveUp = held > LAG_HOLD_LIMIT_MS;
    if (common > DRIFT_STOP && !gaveUp && frequent) {
      previousPollWaited = true;
      return true;
    }
    record(gaveUp ? "clock gave up waiting" : "clock released after ms", held);
    if (gaveUp) lagHoldBlockedUntil = now + LAG_HOLD_PAUSE_MS;
    lagHold = null;
    lagOverSince = null;
    return false;
  }
  if (frequent && common > DRIFT_START && now >= lagHoldBlockedUntil) {
    lagOverSince ??= now;
    if (now - lagOverSince >= LAG_SUSTAIN_MS) {
      lagHold = { since: now };
      record("clock waits for lag", common);
      previousPollWaited = true;
      return true;
    }
  } else lagOverSince = null;
  // Everything ahead of the clock by the same amount: the clock moves up to it. Only
  // settled positions count, since an engine may report ahead of its sound while it starts.
  const ahead = lags.length === active.length && active.every((transport) => transport.settled(now))
    ? -Math.max(...lags)
    : 0;
  if (frequent && ahead > DRIFT_START && now >= leadBlockedUntil) {
    leadOverSince ??= now;
    if (now - leadOverSince >= LAG_SUSTAIN_MS) {
      leadOverSince = null;
      if (skipPlaybackAhead(ahead)) {
        record("clock skips ahead", ahead);
        // The elements hear of it with the next frame: nothing is judged before then.
        leadBlockedUntil = now + LEAD_PAUSE_MS;
        for (const transport of active) transport.clockMoved();
      }
    }
  } else leadOverSince = null;
  return false;
}

export class MediaPlayback {
  private snapshot: PlaybackSnapshot | null = null;
  private disposed = false;
  private requested = false;
  private pending = false;
  private waiting = false;
  private seekWhenReady = true;
  private previousPlaying = false;
  private failed = false;
  private clockHeld = false;
  private waitingSince: number | null = null;
  private playRequest = 0;
  /** Playing without sound because the engine refused an unprimed element. */
  private silenced = false;
  /** A start of the whole timeline: the clock waits until this element really runs. */
  private gate = false;
  /** Joining a running timeline: seek ahead by what the engine needs instead of stopping the clock. */
  private lead = false;
  /** When the engine was last asked to start or seek, and how. */
  private restartAt = 0;
  private restartKind: Restart = "restart";
  private progressFrom = 0;
  private progressed = false;
  /** When the reported position began to move after the latest start. */
  private progressAt = 0;
  /** A corrective seek is in flight: it is not buffering. */
  private correctingSince: number | null = null;
  /** The start whose delay is still to be measured, and the reading that waits to be confirmed. */
  private learning: Restart | null = null;
  private probe: { at: number; delay: number } | null = null;
  /** Signed fraction added to the rate: positive catches up. */
  private trim = 0;
  private trimSince = 0;
  private trimFrom = 0;
  private driftSince: number | null = null;
  private updatedAt = 0;
  private listeners: [string, EventListener][] = [];

  constructor(
    private element: HTMLMediaElement,
    private onError: (message: string) => void,
    /** A problem that does not stop playback. */
    private onNotice?: (message: string) => void,
  ) {
    transports.add(this);
    // A trimmed rate must not change the pitch (the default, stated for engines that differ).
    const pitched = element as { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
    if (pitched.preservesPitch === false) pitched.preservesPitch = true;
    if (pitched.webkitPreservesPitch === false) pitched.webkitPreservesPitch = true;
    // An ended element is paused by the browser: a later seek must play it again.
    this.listen("ended", () => { if (!this.pending) this.requested = false; });
    this.listen("loadedmetadata", () => { this.seekWhenReady = true; this.synchronize(); });
    this.listen("canplay", () => { this.waiting = false; this.synchronize(); });
    this.listen("playing", () => { this.waiting = false; });
    this.listen("waiting", () => {
      this.waiting = true;
      // Buffering is not the engine's start delay (a seek's own wait is part of its cost).
      if (this.learning === "restart" && !this.element.seeking) this.learning = null;
    });
    this.listen("stalled", () => { this.waiting = this.element.readyState < 3; });
    this.listen("seeked", () => {
      if (this.element.readyState >= 3) this.waiting = false;
      this.correctingSince = null;
      // Movement counts from where the seek landed.
      this.progressFrom = this.element.currentTime;
      this.synchronize();
    });
    this.listen("error", () => {
      if (this.snapshot?.active) this.fail("미디어를 재생할 수 없습니다. 정밀 재생으로 확인해 주세요.");
    });
  }

  private listen(name: string, listener: EventListener) {
    this.listeners.push([name, listener]);
    this.element.addEventListener(name, listener);
  }

  update(snapshot: PlaybackSnapshot) {
    const now = performance.now();
    const starts = snapshot.playing && snapshot.active && !this.previousPlaying;
    const previous = this.snapshot;
    const explicitSeek = !!previous && (snapshot.seekEpoch ?? 0) !== (previous.seekEpoch ?? 0);
    const mappingChanged = !!previous &&
      (snapshot.speed !== previous.speed || snapshot.reverse !== previous.reverse);
    if (starts || explicitSeek || mappingChanged || !snapshot.playing || snapshot.reverse)
      this.seekWhenReady = true;
    if (snapshot.playing && snapshot.active && !snapshot.reverse) {
      // The timeline was already running when this clip's turn came: it joins without
      // stopping the others. Everything else starts, or starts again, together.
      if (starts && previous?.playing && !explicitSeek) this.lead = true;
      else if (starts || explicitSeek || mappingChanged) { this.gate = true; this.lead = false; }
    }
    const frequent = now - this.updatedAt < FREQUENT_MS;
    this.updatedAt = now;
    this.previousPlaying = snapshot.playing && snapshot.active;
    this.snapshot = snapshot;
    if (!this.shouldPlay()) {
      this.clockHeld = false;
      this.waitingSince = null;
      this.gate = false;
      this.lead = false;
      this.learning = null;
    }
    this.synchronize();
    this.correct(now, frequent);
  }

  private shouldPlay() {
    return !!this.snapshot?.playing && !!this.snapshot.active && !this.snapshot.reverse;
  }

  participates() {
    return !this.disposed && !this.failed && this.shouldPlay();
  }

  private correcting(now = performance.now()) {
    return this.correctingSince !== null && now - this.correctingSince < CORRECTION_LIMIT_MS;
  }

  needsData() {
    if (!this.participates()) return false;
    const el = this.element;
    // Metadata is needed for any seek; beyond that a corrective seek runs beside the clock.
    if (el.readyState < 1) return true;
    if (this.correcting()) return false;
    return el.readyState < 3 || el.seeking || this.seekWhenReady || this.waiting;
  }

  waitingForClock(now: number) {
    if (!this.participates() || (!this.needsData() && !(this.pending && !this.correcting(now)))) {
      this.waitingSince = null;
      if (!this.participates()) return false;
      this.watchProgress(now);
      return this.gated(now);
    }
    this.waitingSince ??= now;
    if (now - this.waitingSince >= PREVIEW_READY_TIMEOUT_MS) {
      this.fail("미디어 준비가 지연되어 재생을 멈췄습니다. 다시 재생하거나 정밀 재생을 선택해 주세요.");
    }
    return true;
  }

  /** A start of the whole timeline waits until the element moves and the engine's start delay is over. */
  private gated(now: number) {
    if (!this.gate || this.clockHeld) return false;
    // A hidden window moves the clock a few times a second at most: holding it for a
    // tick would put it further from the sound than the start delay does.
    if (document.visibilityState === "hidden") { this.gate = false; return false; }
    if (!this.progressed) return true;
    if (now < this.soundDue()) return true;
    this.gate = false;
    record("start gate opened after ms", now - this.restartAt);
    return false;
  }

  /**
   * When the sound of the latest start or seek is expected. A start is timed from the
   * first movement of the position, but not beyond what a whole start usually takes:
   * now and then the position moves late and is the sound from there on.
   */
  private soundDue() {
    if (this.restartKind === "seek") return this.restartAt + seekLatency() * 1000;
    const afterMove = this.progressAt + calibration.afterMove * 1000;
    if (!calibration.restart) return afterMove;
    return Math.max(this.progressAt, Math.min(afterMove, this.restartAt + (calibration.restart + START_MARGIN) * 1000));
  }

  /**
   * Notes when the position began to move after a start. An engine takes a varying time
   * to get that far and a constant time from there to the sound, so the latter is what
   * is learned and waited for.
   */
  private watchProgress(now: number) {
    if (this.progressed) return;
    const el = this.element;
    const moved = (el.currentTime - this.progressFrom) / this.baseRate();
    if (moved > 0.002) {
      this.progressed = true;
      // It has moved this far already: it began that long ago.
      this.progressAt = Math.max(this.restartAt, now - moved * 1000);
      record("position moved after ms", this.progressAt - this.restartAt);
    } else if (el.paused || el.ended || now - this.restartAt > PROGRESS_TIMEOUT_MS) {
      // An element that is not playing after its start was granted has nothing to wait for.
      this.progressed = true;
      this.progressAt = this.restartAt;
    }
  }

  holdForClock(held: boolean) {
    if (this.disposed || this.clockHeld === held) return;
    this.clockHeld = held;
    if (held) this.stop();
    // Released: it starts again with the others, and the clock waits for that start.
    else if (this.shouldPlay()) this.gate = true;
    this.synchronize();
  }

  private stop() {
    if (!this.element.paused || this.requested || this.pending) this.element.pause();
    if (this.pending) this.playRequest++;
    this.pending = false;
    this.requested = false;
    this.trim = 0;
    this.driftSince = null;
  }

  /** The engine was asked to start or to seek: its position is not trusted for a while. */
  private restarted(kind: Restart, from: number, now = performance.now()) {
    this.restartAt = now;
    this.restartKind = kind;
    this.progressFrom = from;
    this.progressed = false;
    this.learning = kind;
    this.probe = null;
    this.driftSince = null;
  }

  private baseRate() {
    return Math.max(.0625, Math.min(16, this.snapshot?.speed ?? 1));
  }

  private clampTarget(value: number) {
    const el = this.element;
    return Number.isFinite(el.duration)
      ? Math.max(0, Math.min(value, Math.max(0, el.duration - .001)))
      : Math.max(0, value);
  }

  private synchronize() {
    const state = this.snapshot;
    if (this.disposed || !state) return;
    const el = this.element;
    // Use volume for user/track silence. Setting muted then unmuting outside a gesture
    // can cause WebKit to stop a previously started element.
    if (el.muted !== this.silenced) el.muted = this.silenced;
    const volume = state.active ? Math.max(0, Math.min(1, state.volume)) : 0;
    if (el.volume !== volume) el.volume = volume;
    const base = this.baseRate();
    const rate = this.trim ? base * (1 + this.trim) : base;
    if (Math.abs(el.playbackRate - rate) > 1e-9) el.playbackRate = rate;
    // Let the native decoder run continuously between explicit seeks. RAF can
    // arrive late or report a slightly different position; neither means that the
    // user scrubbed. Chasing that clock with currentTime resets audibly stutters.
    if (el.readyState >= 1 && this.seekWhenReady) {
      const ahead = this.lead && this.shouldPlay() ? seekLatency() : 0;
      const leading = ahead >= MIN_LEAD;
      const target = this.clampTarget(state.target + (leading ? ahead * base : 0));
      if (Math.abs(el.currentTime - target) > .02) {
        try { el.currentTime = target; }
        catch { this.seekWhenReady = true; return; }
        if (this.shouldPlay()) {
          this.restarted("seek", target);
          if (this.lead) this.correctingSince = performance.now();
        }
      }
      this.seekWhenReady = false;
      this.lead = false;
    }
    if (this.shouldPlay() && !this.clockHeld) this.play();
    else {
      this.stop();
      if (!this.shouldPlay()) this.failed = false;
    }
  }

  /** The latest start or seek is long enough ago for the reported position to be the sound. */
  settled(now: number) {
    return now - this.restartAt >= SETTLE_MS;
  }

  /** The clock was moved to the media: what was counted against the old clock is void. */
  clockMoved() {
    this.driftSince = null;
  }

  /** Playing, with a position that can be compared with the clock. */
  private steady() {
    const el = this.element;
    // A corrective seek whose `seeked` never came is over once the element no longer seeks.
    if (this.correctingSince !== null && !el.seeking && !this.correcting()) this.correctingSince = null;
    return this.participates() && !this.clockHeld && !this.pending && !this.seekWhenReady &&
      !this.gate && this.correctingSince === null && !this.waiting &&
      !el.paused && !el.seeking && el.readyState >= 3;
  }

  private offset() {
    return (this.clampTarget(this.snapshot!.target) - this.element.currentTime) / this.baseRate();
  }

  /**
   * How far behind the clock this element is, or null while that cannot be told.
   * `frozen`: the clock has stood still since the last update, so the target is exact;
   * otherwise it has moved on by the time since.
   */
  lag(now: number, frozen: boolean) {
    if (!this.steady()) return null;
    return this.offset() + (frozen ? 0 : Math.max(0, now - this.updatedAt) / 1000);
  }

  /**
   * How long the engine really took: the time since the start or seek, less what the
   * element has played (and, for a start, the same counted from the first movement of the
   * position). Taken once the element is seen to run at its rate, since an engine may
   * report a position that runs on and then stands still while it starts.
   */
  private measure(now: number) {
    if (!this.learning) return;
    // The movement was not seen (no frames then): this start cannot be split.
    if (!this.progressed) { this.learning = null; return; }
    const played = (this.element.currentTime - this.progressFrom) / this.baseRate();
    const delay = (now - this.restartAt) / 1000 - played;
    if (this.probe && now - this.probe.at >= PROBE_GAP_MS) {
      if (Math.abs(delay - this.probe.delay) <= PROBE_AGREE) {
        learn(this.learning, delay);
        if (this.learning === "restart") learn("afterMove", delay - (this.progressAt - this.restartAt) / 1000);
        this.learning = null;
        this.probe = null;
        return;
      }
      this.probe = null;
    }
    this.probe ??= { at: now, delay };
    // An element that never settles is not measured.
    if (now - this.restartAt > SETTLE_MS + LAG_HOLD_LIMIT_MS) this.learning = null;
  }

  /** Runs with a fresh target only: trims the rate or seeks an element that is off on its own. */
  private correct(now: number, frequent: boolean) {
    if (!this.steady() || !frequent) {
      this.driftSince = null;
      // Without a frame-by-frame clock (a hidden window) nothing is chased.
      if (this.trim && !frequent) this.endTrim();
      return;
    }
    if (now - this.restartAt < SETTLE_MS) return;
    this.measure(now);
    const error = this.offset();
    const size = Math.abs(error);
    if (this.trim) {
      const remaining = this.trim > 0 ? error : -error;
      const gained = this.trimFrom - Math.max(0, remaining);
      const trimmedFor = (now - this.trimSince) / 1000;
      if (gained > MAX_TRIM * trimmedFor + TRIM_HARM || remaining < -TRIM_HARM) {
        // The offset moved far more than a trim can move it: the rate change stalled the
        // element. This engine is not trimmed again; what is left is judged afresh.
        calibration.trimUsable = false;
        record("rate change stalled the element", gained);
        this.endTrim();
      } else if (now - this.trimSince < 1000 && size - this.trimFrom > TRIM_HARM) {
        // The rate change itself threw the element off: this engine is not trimmed again.
        calibration.trimUsable = false;
        this.seekCorrect(now);
      } else if (remaining < DRIFT_STOP) this.endTrim();
      else if (size > DRIFT_SEEK + TRIM_HARM) this.seekCorrect(now);
      else this.setTrim(error);
      return;
    }
    if (size <= DRIFT_START) { this.driftSince = null; return; }
    this.driftSince ??= now;
    if (now - this.driftSince < DRIFT_SUSTAIN_MS) return;
    this.driftSince = null;
    if (size > DRIFT_SEEK || !calibration.trimUsable) this.seekCorrect(now);
    else {
      this.trimSince = now;
      this.trimFrom = size;
      this.setTrim(error);
    }
  }

  /** Proportional, in whole percents so that the rate is written a handful of times at most. */
  private setTrim(error: number) {
    const percent = Math.max(1, Math.min(MAX_TRIM * 100, Math.round(Math.abs(error) * 100)));
    const trim = Math.sign(error) * percent / 100;
    if (trim === this.trim) return;
    this.trim = trim;
    record("trim", trim);
    this.synchronize();
  }

  private endTrim() {
    if (this.trim) record("trim ended");
    this.trim = 0;
    this.driftSince = null;
    this.synchronize();
  }

  /** Seek to where the clock will be when the engine has taken the time a seek costs it. */
  private seekCorrect(now: number) {
    this.trim = 0;
    this.driftSince = null;
    const el = this.element;
    const base = this.baseRate();
    if (Math.abs(el.playbackRate - base) > 1e-9) el.playbackRate = base;
    const ahead = seekLatency();
    const target = this.clampTarget(this.snapshot!.target + (ahead >= MIN_LEAD ? ahead * base : 0));
    try { el.currentTime = target; }
    catch { return; }
    this.restarted("seek", target, now);
    this.correctingSince = now;
    record("corrective seek to", target);
  }

  private fail(message: string) {
    this.failed = true;
    this.stop();
    if (!this.disposed) this.onError(message);
  }

  private play(gesture = false) {
    if (this.disposed || this.pending || (!gesture && (this.requested || this.failed))) return;
    this.requested = true;
    this.pending = true;
    const request = ++this.playRequest;
    if (gesture) this.failed = false;
    // A seek that is under way already counts as the later, costlier start.
    if (!this.element.seeking) this.restarted("restart", this.element.currentTime);
    let promise: Promise<void>;
    record("play()");
    try { promise = this.element.play(); }
    catch { this.pending = false; this.fail("소리를 시작하지 못했습니다. 재생을 다시 눌러주세요."); return; }
    void Promise.resolve(promise).then(() => {
      if (request !== this.playRequest) return;
      this.pending = false;
      if (this.disposed) return;
      if (!this.shouldPlay() || this.clockHeld) this.stop();
    }).catch((error: unknown) => {
      if (request !== this.playRequest) return;
      this.pending = false;
      this.requested = false;
      if (this.disposed || !this.shouldPlay()) return;
      // A DOMException of another realm is not `instanceof Error`: go by its name.
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "AbortError") return;
      const refused = name === "NotAllowedError";
      // Elements mounted after the play gesture were never primed. An engine that
      // grants playback per element refuses their sound, but not a muted start:
      // keep the timeline running and play this one silently.
      if (refused && !this.silenced) {
        this.silenced = true;
        this.element.muted = true;
        this.onNotice?.("브라우저가 소리 자동 재생을 막아 이 클립은 소리 없이 재생합니다. 재생을 멈췄다가 다시 누르면 소리가 납니다.");
        this.play();
        return;
      }
      this.fail(refused
        ? "소리 재생을 시작하려면 재생 버튼을 다시 눌러주세요."
        : "미디어 재생에 실패했습니다. 다시 재생하거나 정밀 재생을 선택해 주세요.");
    });
  }

  prime() {
    if (!this.snapshot || !this.element.getAttribute("src")) return;
    if (this.element.volume !== 0) this.element.volume = 0;
    // Inside the gesture the element may sound again.
    this.silenced = false;
    if (this.element.muted) this.element.muted = false;
    this.play(true);
    // React's playback update follows this same gesture. Inactive elements remain
    // silent and pause when the pending play resolves, but retain their permission.
  }

  dispose() {
    this.disposed = true;
    transports.delete(this);
    for (const [name, listener] of this.listeners) this.element.removeEventListener(name, listener);
    this.stop();
  }
}
