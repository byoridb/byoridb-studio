/** Native media transport shared by source clips and the rendered preview. */
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
  // Visit every source, including after one waits, to maintain bounded timers.
  return active.map((transport) => transport.waitingForClock(now)).some(Boolean);
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
  private listeners: [string, EventListener][] = [];

  constructor(
    private element: HTMLMediaElement,
    private onError: (message: string) => void,
    /** A problem that does not stop playback. */
    private onNotice?: (message: string) => void,
  ) {
    transports.add(this);
    // An ended element is paused by the browser: a later seek must play it again.
    this.listen("ended", () => { if (!this.pending) this.requested = false; });
    this.listen("loadedmetadata", () => { this.seekWhenReady = true; this.synchronize(); });
    this.listen("canplay", () => { this.waiting = false; this.synchronize(); });
    this.listen("playing", () => { this.waiting = false; });
    this.listen("waiting", () => { this.waiting = true; });
    this.listen("stalled", () => { this.waiting = this.element.readyState < 3; });
    this.listen("seeked", () => {
      if (this.element.readyState >= 3) this.waiting = false;
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
    const starts = snapshot.playing && snapshot.active && !this.previousPlaying;
    const previous = this.snapshot;
    const explicitSeek = !!previous && (snapshot.seekEpoch ?? 0) !== (previous.seekEpoch ?? 0);
    const mappingChanged = !!previous &&
      (snapshot.speed !== previous.speed || snapshot.reverse !== previous.reverse);
    if (starts || explicitSeek || mappingChanged || !snapshot.playing || snapshot.reverse)
      this.seekWhenReady = true;
    this.previousPlaying = snapshot.playing && snapshot.active;
    this.snapshot = snapshot;
    if (!this.shouldPlay()) {
      this.clockHeld = false;
      this.waitingSince = null;
    }
    this.synchronize();
  }

  private shouldPlay() {
    return !!this.snapshot?.playing && !!this.snapshot.active && !this.snapshot.reverse;
  }

  participates() {
    return !this.disposed && !this.failed && this.shouldPlay();
  }

  needsData() {
    return this.participates() &&
      (this.element.readyState < 3 || this.element.seeking || this.seekWhenReady || this.waiting);
  }

  waitingForClock(now: number) {
    if (!this.participates() || (!this.needsData() && !this.pending)) {
      this.waitingSince = null;
      return false;
    }
    this.waitingSince ??= now;
    if (now - this.waitingSince >= PREVIEW_READY_TIMEOUT_MS) {
      this.fail("미디어 준비가 지연되어 재생을 멈췄습니다. 다시 재생하거나 정밀 재생을 선택해 주세요.");
    }
    return true;
  }

  holdForClock(held: boolean) {
    if (this.disposed || this.clockHeld === held) return;
    this.clockHeld = held;
    if (held) this.stop();
    this.synchronize();
  }

  private stop() {
    if (!this.element.paused || this.requested || this.pending) this.element.pause();
    if (this.pending) this.playRequest++;
    this.pending = false;
    this.requested = false;
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
    const rate = Math.max(.0625, Math.min(16, state.speed));
    if (el.playbackRate !== rate) el.playbackRate = rate;
    const target = Number.isFinite(el.duration)
      ? Math.max(0, Math.min(state.target, Math.max(0, el.duration - .001)))
      : Math.max(0, state.target);
    const drift = Math.abs(el.currentTime - target);
    // Let the native decoder run continuously between explicit seeks. RAF can
    // arrive late or report a slightly different position; neither means that the
    // user scrubbed. Chasing that clock with currentTime resets audibly stutters.
    if (el.readyState >= 1 && this.seekWhenReady) {
      if (drift > .02) {
        try { el.currentTime = target; }
        catch { this.seekWhenReady = true; return; }
      }
      this.seekWhenReady = false;
    }
    if (this.shouldPlay() && !this.clockHeld) this.play();
    else {
      this.stop();
      if (!this.shouldPlay()) this.failed = false;
    }
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
    let promise: Promise<void>;
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
