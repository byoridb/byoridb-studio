import { Fragment, memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Keyboard,
  ListPlus,
  MoveHorizontal,
  Eye,
  EyeOff,
  Flag,
  Link2,
  Unlink2,
  ListMinus,
  Lock,
  Magnet,
  Minus,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Unlock,
  Volume2,
  VolumeX,
  Film,
  Type,
  Music2,
  ArrowLeftToLine,
  ArrowRightToLine,
} from "lucide-react";
import type { Clip, EditCommand, Project, Track, TransitionType } from "./types";
import { durationOf, timecode } from "./types";
import { assetUrl } from "./api";
import {
  clipEditCommands,
  clipJunctions,
  junctionTransitionCommands,
  maxTransitionDuration,
  presentIds,
  trimClipPreview,
  waveformBars,
  waveformRange,
  type ClipEditAction,
  type ClipJunction,
} from "./clipEditing";
import { transitionCatalog } from "./clipPresets";
import { playbackClock, useClockTime, useClockValue } from "./playbackClock";
import {
  canEditSelection,
  clipGroup,
  moveSelection,
  moveSelectionToTrack,
  newClipIds,
  selectedClips,
  toggleSelection,
  trackKindForClip,
} from "./selection";
import type { Waveforms } from "./waveforms";
import "./timeline.css";

interface Drag {
  id: string;
  mode: "move" | "left" | "right";
  x: number;
  origin: Clip;
  clips: Clip[];
  revision: number;
  scroll: number;
  previews: Record<string, Partial<Clip>>;
  targetTrack?: string;
}
/** Room, in pixels, the trim readout needs to sit before the dragged edge. */
const TRIM_READOUT_ROOM = 240;
const trackNames: Record<Track["kind"], string> = { video: "영상", audio: "오디오", text: "자막·텍스트" };
const hasMarker = (project: Project, id: string) => project.markers.some((marker) => marker.id === id);

// These visuals do not change as the playhead moves. Keep their DOM work out
// of the playback clock while leaving all editing handlers on the live parent.
const ClipVisual = memo(function ClipVisual({ kind, thumbnail, waveform, from = 0, to, reverse }: {
  kind: Clip["kind"];
  thumbnail?: string;
  waveform?: number[];
  from?: number;
  to?: number;
  reverse?: boolean;
}) {
  if (kind === "video" || kind === "image")
    return <div className="clip-thumbnails" style={{ backgroundImage: `url("${thumbnail}")` }} />;
  if (kind === "audio") {
    const bars = waveformBars(waveform?.slice(from, to) ?? []);
    return <div className="clip-waveform" aria-hidden="true">
      {(reverse ? [...bars].reverse() : bars).map((peak, index) => (
        <i key={index} style={{ height: `${Math.max(2, peak * 100)}%`, flex: 1 }} />
      ))}
    </div>;
  }
  // A text clip is its label: the name already is the text.
  return null;
});

const RulerTicks = memo(function RulerTicks({ first, last, step, zoom }: {
  first: number;
  last: number;
  step: number;
  zoom: number;
}) {
  return <>{Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => {
    const index = first + offset;
    return (
      <span key={index} style={{ left: index * step * zoom }}>
        {`${Math.floor((index * step) / 60).toString().padStart(2, "0")}:${((index * step) % 60).toString().padStart(2, "0")}`}
      </span>
    );
  })}</>;
});

/** The only timeline parts that follow the playback clock frame by frame. */
function Playhead({ zoom, fixed, scrub }: { zoom: number; fixed?: number; scrub: Record<string, unknown> }) {
  const clock = useClockTime();
  return (
    <div className="playhead" style={{ left: (fixed ?? clock) * zoom }}>
      <div className="playhead-handle" title="드래그해서 탐색" {...scrub} />
    </div>
  );
}
/** The names the Library and Inspector use (clipPresets.transitionCatalog). */
const transitionLabels = Object.fromEntries(
  transitionCatalog.map((item) => [item.id, item.name]),
) as Record<TransitionType, string>;

interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  separator?: boolean;
  run: () => void;
}
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.right > window.innerWidth) element.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
    if (rect.bottom > window.innerHeight) element.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }, [x, y]);
  return (
    <div className="context-menu" role="menu" ref={ref} style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); return; }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      {items.map((item, index) => (
        <button key={`${index}:${item.label}`} role="menuitem" className={item.separator ? "separated" : ""} disabled={item.disabled}
          onClick={() => { onClose(); item.run(); }}>
          {item.label}{item.hint && <kbd>{item.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}

function TrackName({ track, onRename }: { track: Track; onRename: (name: string) => void }) {
  const [name, setName] = useState(track.name);
  const cancelled = useRef(false);
  useEffect(() => setName(track.name), [track.name]);
  return <input aria-label={`${track.name} 이름`} title="트랙 이름 변경" value={name} disabled={track.locked} maxLength={100}
    onChange={(event) => setName(event.target.value)}
    onBlur={() => {
      if (cancelled.current) { cancelled.current = false; return; }
      const next = name.trim();
      if (next && next !== track.name) onRename(next);
      else setName(track.name);
    }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { cancelled.current = true; setName(track.name); event.currentTarget.blur(); }
    }} />;
}
interface TimelineProps {
  project: Project;
  /** A fixed playhead for embedding; by default the timeline follows the playback clock. */
  time?: number;
  onTime: (value: number) => void;
  selectedId: string | null;
  selectedIds: string[];
  selectedTrackId?: string | null;
  onTrackSelect?: (id: string) => void;
  onSelection: (ids: string[], primary?: string | null) => void;
  /**
   * Edits are given as a function of the project: the app makes the command when
   * its turn comes, from the project the edits before it left.
   */
  onCommand: EditCommand;
  /** Waveform peaks by media id, when the project carries only their count. */
  waveforms?: Waveforms;
  history: { canUndo: boolean; canRedo: boolean };
  playing?: boolean;
  /** The player's repeated range, drawn on the ruler. */
  loop?: { start: number; end: number } | null;
  /** ⌥-dragging the ruler marks the repeated range. */
  onLoop?: (range: { start: number; end: number } | null) => void;
  /** Clipboard actions owned by the editor: copy (or cut) the selection, paste at a time. */
  onCopy?: (cut: boolean) => void;
  onPaste?: (at: number) => void;
  canPaste?: boolean;
}
type MenuTarget =
  | { kind: "clip"; id: string }
  | { kind: "track"; id: string }
  | { kind: "addTrack" }
  | { kind: "empty"; trackId: string; time: number };
/** Clips are drawn only inside the scrolled window plus this margin on each side. */
const OVERSCAN = 600;
const VIEW_STEP = 300;
const MIN_ZOOM = 0.1, MAX_ZOOM = 180, DEFAULT_ZOOM = 68;
const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
/** Zoom and snapping are remembered per project; storage may be unavailable. */
const viewKey = (projectId: string) => `byori.timeline.${projectId}`;
const storedView = (projectId: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(viewKey(projectId)) || "null") as { zoom?: unknown; snap?: unknown } | null;
    return {
      zoom: typeof value?.zoom === "number" && Number.isFinite(value.zoom) && value.zoom > 0 ? clampZoom(value.zoom) : DEFAULT_ZOOM,
      snap: value?.snap !== false,
    };
  } catch {
    return { zoom: DEFAULT_ZOOM, snap: true };
  }
};
const SHORTCUTS: [string, string][] = [
  ["Space", "재생 · 일시정지"],
  ["← →", "한 프레임 이동 (⇧ 1초)"],
  ["↑ ↓", "이전 · 다음 편집점"],
  ["⌘B", "재생 헤드에서 나누기"],
  ["Q · W", "앞부분 · 뒷부분 자르기"],
  ["⌘C · ⌘X · ⌘V", "복사 · 잘라내기 · 붙여넣기"],
  ["⌘D", "복제"],
  ["Delete", "삭제 (⇧ 간격을 당기며 삭제)"],
  ["⌘G · ⇧⌘G", "그룹 · 그룹 해제"],
  ["⌥← →", "선택 클립 한 프레임 이동 (⇧ 10프레임)"],
  ["⌥↑ ↓", "선택 클립을 옆 트랙으로"],
  ["⇧ · ⌘ 클릭", "여러 클립 선택"],
  ["M", "마커 추가"],
  ["I · O", "반복 구간 시작 · 끝"],
  ["⌥ 눈금 드래그", "반복 구간 지정"],
  ["⌘ 휠", "타임라인 확대 · 축소"],
  ["⌘Z · ⇧⌘Z", "실행 취소 · 다시 실행"],
];
const sliderOf = (zoom: number) => Math.round(Math.log(zoom) * 100);
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const EDGE = 36;
const DRAG_THRESHOLD = 4;
export default function Timeline({
  project,
  time: fixedTime,
  onTime,
  selectedId,
  selectedIds,
  selectedTrackId,
  onTrackSelect,
  onSelection,
  onCommand,
  waveforms,
  history,
  playing = false,
  loop = null,
  onLoop,
  onCopy,
  onPaste,
  canPaste = false,
}: TimelineProps) {
  const now = () => fixedTime ?? playbackClock.get();
  const [viewProject, setViewProject] = useState(project.id);
  const [zoom, setZoom] = useState(() => storedView(project.id).zoom);
  const [markerEdit, setMarkerEdit] = useState<string | null>(null);
  const [transitionEdit, setTransitionEdit] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  // The scrolled window, in coarse steps so scrolling re-renders only now and then.
  const [view, setView] = useState({ left: 0, width: 0 });
  const workspace = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const zoomAnchor = useRef<{ time: number; x: number } | null>(null);
  const labelsWidth = () => labels.current?.offsetWidth ?? 0;
  const [snap, setSnap] = useState(() => storedView(project.id).snap);
  // Another project brings its own remembered view.
  if (viewProject !== project.id) {
    const stored = storedView(project.id);
    setViewProject(project.id);
    setZoom(stored.zoom);
    setSnap(stored.snap);
  }
  useEffect(() => {
    try {
      localStorage.setItem(viewKey(project.id), JSON.stringify({ zoom, snap }));
    } catch {
      /* The view still applies for this session. */
    }
  }, [project.id, zoom, snap]);
  const [shortcuts, setShortcuts] = useState<{ right: number; bottom: number } | null>(null);
  const shortcutsId = useId();
  const shortcutPopover = useRef<HTMLDivElement>(null);
  const shortcutToggle = useRef<HTMLButtonElement>(null);
  const shortcutsOpen = !!shortcuts;
  useEffect(() => {
    if (!shortcutsOpen) return;
    // Keyboard and screen-reader users land on the list they asked for.
    shortcutPopover.current?.focus();
    const close = () => {
      // Focus goes back to the button unless the pointer already moved it elsewhere.
      const held = shortcutPopover.current?.contains(document.activeElement);
      setShortcuts(null);
      if (held) shortcutToggle.current?.focus();
    };
    const outside = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.(".shortcut-popover, .shortcut-toggle")) setShortcuts(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape closes only the popover; the editor's own Escape would also clear the selection.
      event.stopPropagation();
      event.preventDefault();
      close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [shortcutsOpen]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const activeDrag = useRef<Drag | null>(null);
  // A released drag stays where it was dropped until the service has answered, so
  // the clip neither jumps back for a moment nor is picked up from its old place
  // by a drag that starts before the answer arrives.
  const [held, setHeld] = useState<{ key: number; previews: Drag["previews"] }[]>([]);
  const heldKey = useRef(0);
  const hold = (previews: Drag["previews"], task: Promise<unknown>) => {
    const key = ++heldKey.current;
    setHeld((list) => [...list, { key, previews }]);
    const release = () => setHeld((list) => list.filter((entry) => entry.key !== key));
    task.then(release, release);
  };
  /** What is drawn over the project: drops still on their way, then the drag in hand. */
  const shown = useMemo(() => {
    const merged: Drag["previews"] = {};
    for (const previews of [...held.map((entry) => entry.previews), drag?.previews ?? {}])
      for (const [id, patch] of Object.entries(previews)) merged[id] = { ...merged[id], ...patch };
    return merged;
  }, [held, drag]);
  const settled = useRef(shown);
  settled.current = shown;
  const trackRows = useRef(new Map<string, HTMLDivElement>());
  const editGuideId = useId();
  const editable = canEditSelection(project, selectedIds);
  const selection = selectedClips(project, selectedIds);
  const cutCount = useClockValue((clock) =>
    clipEditCommands(project, selectedIds, fixedTime ?? clock, "split").length);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const { clipsByTrack, junctionsByTrack, overlapIn } = useMemo(() => {
    const clipsByTrack = new Map<string, Clip[]>();
    for (const clip of project.clips) {
      const list = clipsByTrack.get(clip.trackId);
      if (list) list.push(clip);
      else clipsByTrack.set(clip.trackId, [clip]);
    }
    const junctionsByTrack = new Map<string, ClipJunction[]>();
    // How far each clip starts under the clip before it (seconds): its label
    // begins after that, clear of the overlap marking.
    const overlapIn = new Map<string, number>();
    for (const [trackId, clips] of clipsByTrack) {
      const junctions = clipJunctions(clips, project.fps);
      junctionsByTrack.set(trackId, junctions);
      for (const { before, after } of junctions) {
        const overlap = Math.min(before.start + before.duration, after.start + after.duration) - after.start;
        if (overlap > 0) overlapIn.set(after.id, overlap);
      }
    }
    return { clipsByTrack, junctionsByTrack, overlapIn };
  }, [project.clips, project.fps]);
  const selectionKind = selection.length && selection.every((clip) => trackKindForClip(clip) === trackKindForClip(selection[0]))
    ? trackKindForClip(selection[0]) : null;
  const duration = durationOf(project);
  const length = Math.max(duration + 3, 15);
  const width = Math.max(800, length * zoom);
  const step = RULER_STEPS.find((seconds) => seconds * zoom >= 56) ?? RULER_STEPS[RULER_STEPS.length - 1];
  // Before the first measurement (and in tests without layout) assume one window width.
  const viewWidth = view.width || (typeof window === "undefined" ? 1280 : window.innerWidth);
  const visibleFrom = (view.left - OVERSCAN) / zoom;
  const visibleTo = (view.left + viewWidth + OVERSCAN) / zoom;
  const inView = (start: number, end: number) => end >= visibleFrom && start <= visibleTo;
  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = { left: Math.floor(element.scrollLeft / VIEW_STEP) * VIEW_STEP, width: Math.ceil((element.clientWidth + VIEW_STEP) / VIEW_STEP) * VIEW_STEP };
      if (!element.clientWidth) next.width = 0;
      setView((previous) => previous.left === next.left && previous.width === next.width ? previous : next);
    };
    const schedule = () => { frame ||= requestAnimationFrame(read); };
    read();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
    };
  }, []);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // ⌘/Ctrl + wheel zooms around the pointer; React's wheel listener is passive.
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const x = Math.max(0, event.clientX - element.getBoundingClientRect().left - labelsWidth());
      zoomAnchor.current = { time: (element.scrollLeft + x) / zoomRef.current, x };
      setZoom(clampZoom(zoomRef.current * Math.exp(-event.deltaY * 0.002)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (anchor && workspace.current)
      workspace.current.scrollLeft = Math.max(0, anchor.time * zoom - anchor.x);
  }, [zoom]);
  // Playback keeps the playhead in view by paging the timeline.
  useLayoutEffect(() => {
    if (!playing) return;
    const follow = () => {
      const element = workspace.current;
      if (!element) return;
      const viewport = element.clientWidth - labelsWidth();
      const x = now() * zoom;
      if (viewport > 0 && (x < element.scrollLeft || x > element.scrollLeft + viewport - 24))
        element.scrollLeft = Math.max(0, x - 24);
    };
    follow();
    return playbackClock.subscribe(follow);
  }, [playing, fixedTime, zoom]);
  const fitZoom = () => {
    const view = (workspace.current?.clientWidth ?? 0) - labelsWidth() - 24;
    setZoom(clampZoom((view > 0 ? view : 800) / Math.max(duration, 1)));
    if (workspace.current) workspace.current.scrollLeft = 0;
  };
  /**
   * One edit. The command is made by `build` from the project as it is when the
   * edit is sent — after the edits still on their way have been answered — and
   * `build` returns null when what it was for is gone by then (nothing is sent).
   * `sentOn` receives that project, to tell what the edit added.
   */
  const run = (
    method: string,
    build: (latest: Project) => Record<string, unknown> | null,
    sentOn?: (latest: Project) => void,
  ) =>
    onCommand(method, (latest) => {
      sentOn?.(latest);
      return build(latest);
    }).catch(() => undefined);
  const trackIn = (latest: Project, id: string) => latest.tracks.find((track) => track.id === id);
  const editAtPlayhead = async (action: ClipEditAction) => {
    const at = now();
    let basis = project;
    const result = await run("edit.batch", (latest) => {
      const commands = clipEditCommands(latest, presentIds(latest, selectedIds), at, action);
      return commands.length ? { commands } : null;
    }, (latest) => { basis = latest; });
    if (action === "split") {
      const ids = newClipIds(basis, result);
      if (ids.length) onSelection(ids, ids[ids.length - 1]);
    }
  };
  const createTrack = async (kind: Track["kind"], clipIds?: string[]) => {
    let basis = project;
    const result = await run("edit.track", (latest) => {
      const ids = clipIds && presentIds(latest, clipIds);
      // The clips this track was for are gone: no empty track is left behind.
      if (clipIds?.length && !ids?.length) return null;
      return {
        kind,
        name: `${trackNames[kind]} ${latest.tracks.filter((track) => track.kind === kind).length + 1}`,
        ...(ids?.length ? { clipIds: ids } : {}),
      };
    }, (latest) => { basis = latest; });
    if (result && typeof result === "object" && "tracks" in result && Array.isArray(result.tracks)) {
      const added = (result.tracks as Track[]).find((track) => !basis.tracks.some((existing) => existing.id === track.id));
      if (added) onTrackSelect?.(added.id);
    }
  };
  const moveToTrack = (trackId: string) => {
    if (!editable || !selectionKind) return;
    if (trackId === "new") { void createTrack(selectionKind, selectedIds); return; }
    if (moveSelectionToTrack(project, selectedIds, trackId).length)
      void run("edit.batch", (latest) => {
        const commands = moveSelectionToTrack(latest, presentIds(latest, selectedIds), trackId);
        return commands.length ? { commands } : null;
      }).then((result) => {
        if (result) onTrackSelect?.(trackId);
      });
  };
  const frame = (value: number) => Math.max(0, Math.round(value * project.fps) / project.fps);
  /** The closest snap target (clip edges, playhead, markers, zero) within reach. */
  const snapPoint = (value: number, excluded: string[]) => {
    if (!snap) return null;
    let best: number | null = null;
    for (const point of [
      0,
      now(),
      ...project.markers.map((marker) => marker.time),
      ...project.clips
        .filter((c) => !excluded.includes(c.id))
        .flatMap((c) => [c.start, c.start + c.duration]),
    ])
      if (best === null || Math.abs(point - value) < Math.abs(best - value)) best = point;
    return best !== null && Math.abs(best - value) * zoom < 7 ? best : null;
  };
  const snapped = (value: number, excluded: string[] = []) => {
    const n = frame(value);
    return snapPoint(n, excluded) ?? n;
  };
  const timeAt = (clientX: number) =>
    Math.max(0, Math.min(duration, (clientX - (content.current?.getBoundingClientRect().left ?? 0)) / zoom));
  const seek = (event: React.PointerEvent<HTMLElement>) => onTime(timeAt(event.clientX));
  const loopFrom = useRef<number | null>(null);
  const scrub = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (event.altKey && onLoop) {
        loopFrom.current = frame(timeAt(event.clientX));
        return;
      }
      scrubbing.current = true;
      press(event);
      seek(event);
      edgeScroll();
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (loopFrom.current !== null) {
        const at = frame(timeAt(event.clientX));
        const range = { start: Math.min(loopFrom.current, at), end: Math.max(loopFrom.current, at) };
        onLoop?.(range.end - range.start >= 1 / project.fps ? range : null);
        return;
      }
      if (!scrubbing.current || !travelled(event)) return;
      seek(event);
    },
    onPointerUp: () => { scrubbing.current = false; loopFrom.current = null; },
    onPointerCancel: () => { scrubbing.current = false; loopFrom.current = null; },
  };
  // A press only becomes a drag once the pointer has travelled; until then a
  // plain click neither moves a clip nor starts edge scrolling.
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const press = (event: React.PointerEvent<HTMLElement>) => {
    pressed.current = pointer.current = { x: event.clientX, y: event.clientY };
  };
  const travelled = (event: React.PointerEvent<HTMLElement>) => {
    pointer.current = { x: event.clientX, y: event.clientY };
    const from = pressed.current;
    if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) >= DRAG_THRESHOLD) pressed.current = null;
    return !pressed.current;
  };
  // While a drag or scrub is held near a horizontal edge, scroll and keep it tracking.
  const live = useRef({ applyDrag: (_x: number, _y: number) => {}, timeAt, onTime });
  const edgeFrame = useRef(0);
  const edgeScroll = () => {
    cancelAnimationFrame(edgeFrame.current);
    const tick = () => {
      const element = workspace.current, at = pointer.current;
      if (!element || !at || (!activeDrag.current && !scrubbing.current)) return;
      const rect = element.getBoundingClientRect();
      const left = rect.left + labelsWidth();
      const speed = !rect.width || pressed.current ? 0
        : at.x > rect.right - EDGE ? Math.min(24, 4 + (at.x - rect.right + EDGE) / 2)
        : at.x < left + EDGE ? -Math.min(24, 4 + (left + EDGE - at.x) / 2) : 0;
      if (speed) {
        const before = element.scrollLeft;
        element.scrollLeft = Math.max(0, before + speed);
        if (element.scrollLeft !== before) {
          if (activeDrag.current) live.current.applyDrag(at.x, at.y);
          else live.current.onTime(live.current.timeAt(at.x));
        }
      }
      edgeFrame.current = requestAnimationFrame(tick);
    };
    edgeFrame.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(edgeFrame.current), []);
  const setActiveDrag = (value: Drag | null) => {
    activeDrag.current = value;
    setDrag(value);
  };
  const choose = (clip: Clip, additive: boolean) => {
    const ids = additive
      ? toggleSelection(project, selectedIds, clip.id)
      : clipGroup(project, clip.id);
    onSelection(
      ids,
      ids.includes(clip.id) ? clip.id : ids[ids.length - 1] || null,
    );
    return ids;
  };
  const begin = (
    event: React.PointerEvent<HTMLElement>,
    clip: Clip,
    mode: Drag["mode"],
  ) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.focus();
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (additive && mode === "move") {
      choose(clip, true);
      return;
    }
    const ids =
      mode === "move" && selectedIds.includes(clip.id)
        ? selectedIds
        : clipGroup(project, clip.id);
    onSelection(ids, clip.id);
    if (!canEditSelection(project, mode === "move" ? ids : [clip.id])) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // A drop still on its way to the service is where the clip is, as far as this drag goes.
    const dropped = (item: Clip): Clip => ({ ...item, ...settled.current[item.id] });
    setActiveDrag({
      id: clip.id,
      mode,
      x: event.clientX,
      origin: dropped(clip),
      clips: (mode === "move" ? selectedClips(project, ids) : [clip]).map(dropped),
      revision: project.revision,
      scroll: workspace.current?.scrollLeft ?? 0,
      previews: {},
    });
    press(event);
    edgeScroll();
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    if (!activeDrag.current) return;
    event.stopPropagation();
    if (!travelled(event)) return;
    applyDrag(event.clientX, event.clientY);
  };
  const applyDrag = (clientX: number, clientY: number) => {
    const current = activeDrag.current;
    if (!current) return;
    const clip = current.origin;
    const delta = (clientX - current.x + (workspace.current?.scrollLeft ?? 0) - current.scroll) / zoom;
    const exclude = current.clips.map((item) => item.id);
    let previews: Drag["previews"] = {};
    let targetTrack: string | undefined;
    if (current.mode === "move") {
      // Either edge of the dragged clip may land on a snap target; the nearer one wins.
      const start = frame(clip.start + delta);
      const head = snapPoint(start, exclude), tail = snapPoint(start + clip.duration, exclude);
      const offset = (tail !== null && (head === null || Math.abs(tail - start - clip.duration) < Math.abs(head - start))
        ? tail - clip.duration
        : head ?? start) - clip.start;
      previews = Object.fromEntries(
        moveSelection(current.clips, offset).map((command) => [
          command.params.id,
          command.params.patch,
        ]),
      );
      const destination = project.tracks.find((track) => {
        const rect = trackRows.current.get(track.id)?.getBoundingClientRect();
        return rect && rect.height > 0 && clientY >= rect.top && clientY < rect.bottom;
      });
      if (destination && destination.id !== clip.trackId && !destination.locked && current.clips.every((item) => trackKindForClip(item) === destination.kind)) {
        targetTrack = destination.id;
        for (const item of current.clips) previews[item.id] = { ...previews[item.id], trackId: destination.id };
      }
    } else {
      const edge = current.mode === "left" ? "start" : "end";
      const target = (edge === "start" ? clip.start : clip.start + clip.duration) + delta;
      const patch = trimClipPreview(project, clip, edge, snapped(target, exclude));
      if (patch) previews[clip.id] = patch;
    }
    setActiveDrag({ ...current, previews, targetTrack });
  };
  live.current = { applyDrag, timeAt, onTime };
  const finish = (event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const current = activeDrag.current;
    setActiveDrag(null);
    if (!current) return;
    const commands = Object.entries(current.previews)
      .filter(([id, patch]) => {
        const original = current.clips.find((clip) => clip.id === id)!;
        return Object.entries(patch).some(
          ([key, value]) => original[key] !== value,
        );
      })
      .map(([id, patch]) => ({ method: "edit.update", params: { id, patch } }));
    if (!commands.length) return;
    // The revision is the one the drag began on; the app sends it on top of this
    // window's own edits that were still on their way then.
    if (current.mode === "move") {
      const task = onCommand("edit.batch", {
        commands,
        expectedRevision: current.revision,
      });
      hold(current.previews, task);
      void task.then((result) => {
        if (result && current.targetTrack) onTrackSelect?.(current.targetTrack);
      }).catch(() => undefined);
    } else {
      const clip = { ...current.origin, ...current.previews[current.id] };
      setTrimNote(`${clip.name} · ${trimText(clip)}`);
      const task = onCommand("edit.trim", {
        id: clip.id,
        start: clip.start,
        end: clip.start + clip.duration,
        expectedRevision: current.revision,
      });
      hold(current.previews, task);
      void task.catch(() => undefined);
    }
  };
  const trimWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, clip: Clip, edge: "start" | "end") => {
    // Consume only handle controls; editor shortcuts must keep working after a drag.
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      setActiveDrag(null);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.stopPropagation();
    event.preventDefault();
    if (event.repeat || activeDrag.current) return;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    // One frame from where the edge is when the edit is sent: a second press made
    // before the first is answered moves the edge a second frame.
    const trimmedIn = (latest: Project) => {
      const item = latest.clips.find((candidate) => candidate.id === clip.id);
      if (!item || trackIn(latest, item.trackId)?.locked) return null;
      const target = (edge === "start" ? item.start : item.start + item.duration) + direction / latest.fps;
      const preview = trimClipPreview(latest, item, edge, target);
      return preview ? { ...item, ...preview } : null;
    };
    if (!trimmedIn(project)) return;
    void run("edit.trim", (latest) => {
      const trimmed = trimmedIn(latest);
      return trimmed && { id: trimmed.id, start: trimmed.start, end: trimmed.start + trimmed.duration };
    }).then((result) => {
      // Said once the service has applied it, in the words a trim drag ends with.
      const trimmed = (result as Project | undefined)?.clips?.find((item) => item.id === clip.id);
      if (trimmed) setTrimNote(`${trimmed.name} · ${trimText(trimmed)}`);
    });
  };
  const duplicate = async () => {
    let basis = project;
    const result = await run("edit.duplicate", (latest) => {
      const ids = presentIds(latest, selectedIds);
      return canEditSelection(latest, ids) ? { ids } : null;
    }, (latest) => { basis = latest; });
    const ids = newClipIds(basis, result);
    if (ids.length) onSelection(ids, ids[ids.length - 1]);
  };
  const remove = async (ripple = false) => {
    const result = await run("edit.delete", (latest) => {
      const ids = presentIds(latest, selectedIds);
      return canEditSelection(latest, ids) ? { ids, ripple } : null;
    });
    if (result) onSelection([], null);
  };
  const trimming = drag && drag.mode !== "move"
    ? { ...drag.origin, ...drag.previews[drag.id], edge: drag.mode } : null;
  const trimText = (clip: Pick<Clip, "start" | "duration">) =>
    `${timecode(clip.start, project.fps)} → ${timecode(clip.start + clip.duration, project.fps)} · 길이 ${clip.duration.toFixed(2)}초`;
  // Announced once, when a trim drag is released or a keyboard trim is applied; the live figures stay visual.
  const [trimNote, setTrimNote] = useState("");
  // The transition editor closes when the pointer goes anywhere else.
  useEffect(() => {
    if (!transitionEdit) return;
    const outside = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.(".transition-popover, .clip-junction")) setTransitionEdit(null);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [transitionEdit]);
  const applyTransition = (junction: ClipJunction, transition: { type: string; duration: number } | null) => {
    if (!junctionTransitionCommands(project, junction, transition).length) return;
    void run("edit.batch", (latest) => {
      // The same two clips, where they are by then; nothing if they no longer meet.
      const clips = latest.clips.filter((clip) => clip.trackId === junction.after.trackId);
      const current = clipJunctions(clips, latest.fps).find(({ before, after }) =>
        before.id === junction.before.id && after.id === junction.after.id);
      if (!current || trackIn(latest, current.after.trackId)?.locked) return null;
      const commands = junctionTransitionCommands(latest, current, transition);
      return commands.length ? { commands } : null;
    });
  };
  const addMarker = (time: number) =>
    void run("edit.marker", (latest) => ({ time, label: `마커 ${latest.markers.length + 1}` }));
  /** The selected clips that are still there and editable, as `{ids}`. */
  const selectionIn = (latest: Project, atLeast = 1) => {
    const ids = presentIds(latest, selectedIds);
    return ids.length >= atLeast && canEditSelection(latest, ids) ? { ids } : null;
  };
  const patchTrack = (id: string, patch: (track: Track) => Partial<Track>) =>
    void run("edit.track", (latest) => {
      const track = trackIn(latest, id);
      return track ? { id, patch: patch(track) } : null;
    });
  const openMenu = (event: React.MouseEvent, target: MenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    // A keyboard-opened menu has no pointer position: anchor it to the element.
    const rect = event.currentTarget.getBoundingClientRect();
    const keyboard = !event.clientX && !event.clientY;
    // A toolbar menu hangs below its button.
    if (target.kind === "addTrack") setMenu({ x: rect.left, y: rect.bottom + 4, target });
    else setMenu({ x: keyboard ? rect.left + 12 : event.clientX, y: keyboard ? rect.top + 12 : event.clientY, target });
  };
  const menuItems = (target: MenuTarget): MenuItem[] => {
    const addTracks: MenuItem[] = (["video", "audio", "text"] as const).map((kind, index) => ({
      label: `${trackNames[kind]} 트랙 추가`, separator: index === 0, run: () => void createTrack(kind),
    }));
    const removeTrack = (id: string): MenuItem => {
      const track = project.tracks.find((item) => item.id === id);
      return {
        label: "트랙 삭제", disabled: !track || track.locked,
        run: () => void run("edit.trackDelete", (latest) => {
          const target = trackIn(latest, id);
          return target && !target.locked ? { id } : null;
        }),
      };
    };
    if (target.kind === "addTrack") return addTracks.map((item) => ({ ...item, separator: false }));
    if (target.kind === "track") {
      const index = project.tracks.findIndex((item) => item.id === target.id);
      // One place up or down from where the track is when the edit is sent.
      const moveTrack = (by: number) => void run("edit.trackMove", (latest) => {
        const from = latest.tracks.findIndex((item) => item.id === target.id);
        const to = from + by;
        return from >= 0 && to >= 0 && to < latest.tracks.length ? { id: target.id, index: to } : null;
      });
      return [
        { label: "위로 이동", disabled: index <= 0, run: () => moveTrack(-1) },
        { label: "아래로 이동", disabled: index < 0 || index === project.tracks.length - 1, run: () => moveTrack(1) },
        ...addTracks,
        { ...removeTrack(target.id), separator: true },
      ];
    }
    if (target.kind === "empty")
      return [
        { label: "여기에 붙여넣기", hint: "⌘V", disabled: !canPaste || !onPaste, run: () => onPaste?.(target.time) },
        { label: "마커 추가", hint: "M", run: () => addMarker(target.time) },
        ...addTracks,
        removeTrack(target.trackId),
      ];
    const clip = project.clips.find((item) => item.id === target.id);
    const at = frame(now());
    let basis = project;
    const frozen = !!clip && clip.kind === "video" && editable &&
      at - clip.start >= 1 / project.fps - 1e-7 && clip.start + clip.duration - at >= 1 / project.fps - 1e-7;
    return [
      { label: "복사", hint: "⌘C", disabled: !onCopy || !selectedIds.length, run: () => onCopy?.(false) },
      { label: "잘라내기", hint: "⌘X", disabled: !onCopy || !editable, run: () => onCopy?.(true) },
      { label: "재생 헤드에 붙여넣기", hint: "⌘V", disabled: !canPaste || !onPaste, run: () => onPaste?.(now()) },
      { label: "복제", hint: "⌘D", disabled: !editable, run: () => void duplicate() },
      { label: "재생 헤드에서 나누기", hint: "⌘B", separator: true, disabled: !cutCount, run: () => void editAtPlayhead("split") },
      {
        label: "재생 헤드에 정지 프레임 넣기", disabled: !frozen,
        run: () => void run("edit.freeze", (latest) => {
          basis = latest;
          const item = latest.clips.find((candidate) => candidate.id === target.id);
          const inside = !!item && item.kind === "video" && !trackIn(latest, item.trackId)?.locked &&
            at - item.start >= 1 / latest.fps - 1e-7 && item.start + item.duration - at >= 1 / latest.fps - 1e-7;
          return inside ? { id: target.id, time: at } : null;
        }).then((result) => {
          const ids = newClipIds(basis, result);
          const still = (result as Project | undefined)?.clips?.find((item) => ids.includes(item.id) && item.kind === "image");
          if (still) onSelection([still.id], still.id);
        }),
      },
      // Moving keeps the timing and never changes a clip's kind.
      { label: "새 트랙으로 분리", separator: true, disabled: !editable || !selectionKind, run: () => moveToTrack("new") },
      ...project.tracks
        .filter((track) => track.kind === selectionKind && !selection.every((item) => item.trackId === track.id))
        .map((track) => ({
          label: `‘${track.name}’ 트랙으로 이동${track.locked ? " · 잠김" : ""}`,
          disabled: !editable || track.locked,
          run: () => moveToTrack(track.id),
        })),
      { label: "삭제", hint: "Delete", separator: true, disabled: !editable, run: () => void remove() },
      { label: "간격을 당기며 삭제", hint: "⇧Delete", disabled: !editable, run: () => void remove(true) },
    ];
  };
  const editGuide = !selection.length
    ? "클립을 선택하고 재생 헤드를 자를 위치로 옮기세요"
    : !editable
      ? "트랙 잠금을 해제하면 클립을 편집할 수 있어요"
      : !cutCount
        ? "재생 헤드를 클립 안으로 옮기세요 · 양쪽 1프레임 이상"
        : `${cutCount > 1 ? `${cutCount}개 클립 · ` : ""}재생 헤드에서 자르기 · 양끝 손잡이로 길이 조절`;
  const cutTitle = (title: string) => (cutCount ? title : `${title} · ${editGuide}`);
  const multiple = selectedIds.length > 1;
  return (
    <section className="timeline-panel" aria-label="타임라인">
      <div className="timeline-toolbar">
        <div className="toolbar-group">
          <button
            title="실행 취소 (⌘Z)"
            disabled={!history.canUndo}
            onClick={() => void onCommand("history.undo")}
          >
            <Undo2 size={17} />
          </button>
          <button
            title="다시 실행 (⇧⌘Z)"
            disabled={!history.canRedo}
            onClick={() => void onCommand("history.redo")}
          >
            <Redo2 size={17} />
          </button>
          <i />
          <button aria-label="나누기" title={cutTitle("나누기 (⌘B)")} aria-describedby={editGuideId} disabled={!cutCount || !!drag}
            onClick={() => editAtPlayhead("split")}>
            <Scissors size={16} aria-hidden="true" />
          </button>
          <button aria-label="앞부분 자르기" title={cutTitle("앞부분 자르기 (Q)")} aria-describedby={editGuideId} disabled={!cutCount || !!drag}
            onClick={() => editAtPlayhead("trim-start")}>
            <ArrowLeftToLine size={16} aria-hidden="true" />
          </button>
          <button aria-label="뒷부분 자르기" title={cutTitle("뒷부분 자르기 (W)")} aria-describedby={editGuideId} disabled={!cutCount || !!drag}
            onClick={() => editAtPlayhead("trim-end")}>
            <ArrowRightToLine size={16} aria-hidden="true" />
          </button>
          <i />
          <button
            title="선택 복제 (⌘D)"
            disabled={!editable}
            onClick={() => void duplicate()}
          >
            <Copy size={16} />
          </button>
          <button
            title="선택 삭제 (Delete)"
            disabled={!editable}
            onClick={() => void remove()}
          >
            <Trash2 size={17} />
          </button>
          <button
            title="간격을 당기며 삭제 (⇧Delete)"
            disabled={!editable}
            onClick={() => void remove(true)}
          >
            <ListMinus size={17} />
          </button>
          <i />
          <button
            title="그룹 만들기 (⌘G)"
            disabled={!editable || selectedIds.length < 2}
            onClick={() => void run("edit.group", (latest) => selectionIn(latest, 2))}
          >
            <Link2 size={16} />
          </button>
          <button
            title="그룹 해제 (⇧⌘G)"
            disabled={
              !editable ||
              !selectedClips(project, selectedIds).some(
                (clip) => typeof clip.groupId === "string",
              )
            }
            onClick={() => void run("edit.ungroup", (latest) => selectionIn(latest))}
          >
            <Unlink2 size={16} />
          </button>
          <i />
          <button
            title="마커 추가 (M)"
            onClick={() => addMarker(now())}
          >
            <Flag size={16} />
          </button>
          <button title="트랙 추가" aria-label="트랙 추가" aria-haspopup="menu"
            onClick={(event) => openMenu(event, { kind: "addTrack" })}>
            <ListPlus size={17} />
          </button>
        </div>
        {/* Why an edit is unavailable, for assistive technology. */}
        <span className="sr-only" id={editGuideId} role="status">{editGuide}</span>
        {/* The result of a trim drag, said once on release rather than on every pointer move. */}
        <span className="sr-only trim-result" aria-live="polite">{trimNote}</span>
        <div className="toolbar-group">
          <button
            className={snap ? "active" : ""}
            title="스냅 켜기/끄기"
            aria-pressed={snap}
            onClick={() => setSnap(!snap)}
          >
            <Magnet size={17} />
          </button>
          <i />
          <button title="전체 맞춤" aria-label="타임라인 전체 맞춤" onClick={fitZoom}>
            <MoveHorizontal size={15} />
          </button>
          <button
            title="타임라인 축소"
            onClick={() => setZoom(clampZoom(zoom / 1.25))}
          >
            <Minus size={14} />
          </button>
          <input
            aria-label="타임라인 확대"
            title="⌘/Ctrl + 휠로도 확대·축소"
            type="range"
            min={sliderOf(MIN_ZOOM)}
            max={sliderOf(MAX_ZOOM)}
            value={sliderOf(zoom)}
            onChange={(event) => setZoom(clampZoom(Math.exp(+event.target.value / 100)))}
          />
          <button
            title="타임라인 확대"
            onClick={() => setZoom(clampZoom(zoom * 1.25))}
          >
            <Plus size={14} />
          </button>
          <i />
          <button ref={shortcutToggle} className={`shortcut-toggle ${shortcuts ? "active" : ""}`} title="단축키" aria-label="단축키"
            aria-haspopup="dialog" aria-expanded={shortcutsOpen} aria-controls={shortcutsOpen ? shortcutsId : undefined}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setShortcuts(shortcuts ? null : { right: Math.max(8, window.innerWidth - rect.right), bottom: Math.max(8, window.innerHeight - rect.top + 6) });
            }}>
            <Keyboard size={16} />
          </button>
        </div>
      </div>
      <div className="timeline-workspace" ref={workspace}>
        <div className="track-labels" ref={labels}>
          <div className="track-label-spacer" />
          {project.tracks.map((track) => (
            <div className={`track-label ${track.kind} ${selectedTrackId === track.id ? "active-track" : ""}`} key={track.id}
              title="우클릭: 트랙 이동 · 추가 · 삭제"
              onClick={() => onTrackSelect?.(track.id)}
              onContextMenu={(event) => { onTrackSelect?.(track.id); openMenu(event, { kind: "track", id: track.id }); }}>
              <div className="track-name">
                <button className="track-select-button" aria-label={`${track.name} 트랙 선택`} title={`${trackNames[track.kind]} 트랙 선택`}
                  aria-pressed={selectedTrackId === track.id}>
                  {track.kind === "text" ? <Type size={15} /> : track.kind === "audio" ? <Music2 size={15} /> : <Film size={15} />}
                </button>
                <TrackName track={track} onRename={(name) => patchTrack(track.id, () => ({ name }))} />
              </div>
              {/* Only the switches that mean something for this kind of track. */}
              <div className="track-switches">
                <button
                  className={track.locked ? "on" : ""}
                  title={track.locked ? "트랙 잠금 해제" : "트랙 잠금"}
                  aria-label={`${track.name} 잠금`}
                  aria-pressed={!!track.locked}
                  onClick={() => patchTrack(track.id, () => ({ locked: !track.locked }))}
                >
                  {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
                {track.kind !== "audio" && (
                  <button
                    className={track.hidden ? "on" : ""}
                    title={track.hidden ? "트랙 표시" : "트랙 숨기기"}
                    aria-label={`${track.name} 표시`}
                    aria-pressed={!track.hidden}
                    onClick={() => patchTrack(track.id, () => ({ hidden: !track.hidden }))}
                  >
                    {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
                {track.kind !== "text" && (
                  <button
                    className={track.muted ? "on" : ""}
                    title={track.muted ? "음소거 해제" : "음소거"}
                    aria-label={`${track.name} 음소거`}
                    aria-pressed={!!track.muted}
                    onClick={() => patchTrack(track.id, () => ({ muted: !track.muted }))}
                  >
                    {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="timeline-scroll">
          <div className="timeline-content" ref={content} style={{ width }}>
            <div className="timeline-ruler" {...scrub}>
              <RulerTicks first={Math.max(0, Math.floor(visibleFrom / step))} last={Math.min(Math.ceil(length / step), Math.ceil(visibleTo / step))} step={step} zoom={zoom} />
              {loop && loop.end > loop.start && (
                <div className="timeline-loop" title="반복 구간 · ⌥ 드래그로 다시 지정" style={{ left: loop.start * zoom, width: (loop.end - loop.start) * zoom }} />
              )}
              {project.markers.map((marker) => (
                <button
                  className="timeline-marker"
                  key={marker.id}
                  title={`${marker.label} · Enter 또는 더블클릭해서 이름 변경·삭제`}
                  aria-label={`마커 ${marker.label}`}
                  aria-expanded={markerEdit === marker.id}
                  style={{ left: marker.time * zoom }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTime(marker.time);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setMarkerEdit(marker.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== "F2") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setMarkerEdit(marker.id);
                  }}
                >
                  <i aria-hidden="true" />
                </button>
              ))}
              {project.markers.filter((marker) => marker.id === markerEdit).map((marker) => (
                <div className="marker-popover" key={marker.id} style={{ left: marker.time * zoom }}
                  onPointerDown={(event) => event.stopPropagation()}>
                  <input aria-label="마커 이름" defaultValue={marker.label} maxLength={80} autoFocus
                    onBlur={(event) => {
                      const label = event.target.value.trim();
                      if (label && label !== marker.label)
                        void run("edit.markerUpdate", (latest) => hasMarker(latest, marker.id) ? { id: marker.id, label } : null);
                      if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setMarkerEdit(null);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") { event.currentTarget.value = marker.label; setMarkerEdit(null); }
                    }} />
                  <button title="마커 삭제" aria-label="마커 삭제"
                    // Keep the input focused so its blur does not send a rename ahead of the delete.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { setMarkerEdit(null); void run("edit.markerDelete", (latest) => hasMarker(latest, marker.id) ? { id: marker.id } : null); }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                ref={(element) => { if (element) trackRows.current.set(track.id, element); else trackRows.current.delete(track.id); }}
                className={`timeline-track ${track.kind} ${track.locked ? "locked" : ""} ${drag?.targetTrack === track.id ? "layer-drop-target" : ""}`}
                data-track-id={track.id}
                aria-label={`${track.name} 트랙`}
                onPointerDown={(event) => {
                  if (event.button === 2) return;
                  seek(event);
                  onSelection([], null);
                  onTrackSelect?.(track.id);
                }}
                onContextMenu={(event) => { onTrackSelect?.(track.id); openMenu(event, { kind: "empty", trackId: track.id, time: frame(timeAt(event.clientX)) }); }}
                onDragOver={(event) => {
                  if (!track.locked) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const mediaId = event.dataTransfer.getData(
                    "application/x-studio-media",
                  );
                  const media = project.media.find((asset) => asset.id === mediaId);
                  const compatible = media && (track.kind === "audio" ? media.hasAudio : track.kind === "video" && media.kind !== "audio");
                  if (mediaId && compatible && !track.locked) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const start = snapped((event.clientX - rect.left) / zoom);
                    void run("edit.add", (latest) => {
                      const target = trackIn(latest, track.id);
                      return target && !target.locked && latest.media.some((asset) => asset.id === mediaId)
                        ? { mediaId, trackId: track.id, start }
                        : null;
                    });
                  }
                }}
              >
                {trimming && trimming.trackId === track.id && (() => {
                  // Beside the dragged edge, over the clip; flipped where the timeline's start would cut it off.
                  const edge = (trimming.edge === "left" ? trimming.start : trimming.start + trimming.duration) * zoom;
                  const before = trimming.edge === "right" && edge >= TRIM_READOUT_ROOM;
                  return (
                    <div className={`trim-readout ${before ? "before" : ""}`} aria-hidden="true" style={{ left: edge }}>
                      {trimText(trimming)}
                    </div>
                  );
                })()}
                {(clipsByTrack.get(track.id) ?? [])
                  .filter((clip) => {
                    const preview = shown[clip.id];
                    const start = preview?.start ?? clip.start;
                    return inView(Math.min(start, clip.start), Math.max(start + (preview?.duration ?? clip.duration), clip.start + clip.duration)) ||
                      selectedSet.has(clip.id) || clip.id === drag?.id;
                  })
                  .map((original) => {
                    const clip = {
                      ...original,
                      ...shown[original.id],
                    };
                    const media = project.media.find((item) => item.id === clip.mediaId);
                    const peaks = clip.kind === "audio" && media ? media.waveform ?? waveforms?.get(media.id) : undefined;
                    const [from, to] = peaks ? waveformRange(clip, media!.duration, peaks.length) : [0, 0];
                    return (
                      <div
                        key={clip.id}
                        className={`timeline-clip ${clip.kind} ${selectedSet.has(clip.id) ? "selected" : ""} ${multiple && selectedSet.has(clip.id) ? "multi" : ""} ${clip.id === selectedId ? "primary-selection" : ""} ${media?.missing ? "missing" : ""}`}
                        title={media?.missing ? "원본 파일을 찾을 수 없습니다" : undefined}
                        style={{
                          left: clip.start * zoom,
                          width: Math.max(8, clip.duration * zoom),
                          ...(shown[original.id]?.trackId && shown[original.id].trackId !== original.trackId ? {
                            transform: `translateY(${(trackRows.current.get(shown[original.id].trackId!)?.offsetTop || 0) - (trackRows.current.get(original.trackId)?.offsetTop || 0)}px)`,
                            zIndex: 15,
                          } : {}),
                        }}
                        onPointerCancel={() => setActiveDrag(null)}
                        onContextMenu={(event) => {
                          if (!selectedSet.has(original.id)) onSelection(clipGroup(project, original.id), original.id);
                          openMenu(event, { kind: "clip", id: original.id });
                        }}
                      >
                        <div className="clip-body" role="button" tabIndex={0}
                          aria-pressed={selectedSet.has(clip.id)}
                          aria-label={`${clip.name}, ${clip.start.toFixed(1)}초, ${clip.duration.toFixed(1)}초`}
                          onPointerDown={(event) => { if (event.button !== 2) begin(event, original, "move"); }}
                          onPointerMove={move}
                          onPointerUp={finish}
                          onKeyDown={(event) => {
                            // Space stays with the editor so a clicked clip still plays.
                            if (event.key === "Enter") {
                              event.stopPropagation();
                              event.preventDefault();
                              choose(clip, event.shiftKey || event.metaKey || event.ctrlKey);
                            }
                          }}>
                          <div className="clip-label"
                            style={!drag && overlapIn.has(clip.id) ? { paddingLeft: overlapIn.get(clip.id)! * zoom + 6 } : undefined}>
                            {typeof clip.groupId === "string" ? (
                              <Link2 size={12} aria-label="그룹 클립" />
                            ) : clip.kind === "text" ? (
                              <Type size={12} />
                            ) : clip.kind === "audio" ? (
                              <Music2 size={12} />
                            ) : (
                              <Film size={12} />
                            )}
                            <span>{clip.name}</span>
                            {clip.speed !== 1 && <em>{clip.speed}×</em>}
                          </div>
                          <ClipVisual
                            kind={clip.kind}
                            thumbnail={clip.kind === "video" || clip.kind === "image" ? assetUrl(clip.mediaId!, true) : undefined}
                            waveform={peaks}
                            from={from}
                            to={to}
                            reverse={clip.reverse}
                          />
                        </div>
                        <button
                          className="clip-trim left"
                          aria-label={`${clip.name} 시작점 트림`}
                          title="시작점 트림 · 드래그 또는 ← →로 1프레임 조절"
                          disabled={track.locked}
                          tabIndex={selectedSet.has(clip.id) && !multiple ? 0 : -1}
                          onPointerDown={(event) =>
                            begin(event, original, "left")
                          }
                          onPointerMove={move}
                          onPointerUp={finish}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => trimWithKeyboard(event, original, "start")}
                        />
                        <button
                          className="clip-trim right"
                          aria-label={`${clip.name} 끝점 트림`}
                          title="끝점 트림 · 드래그 또는 ← →로 1프레임 조절"
                          disabled={track.locked}
                          tabIndex={selectedSet.has(clip.id) && !multiple ? 0 : -1}
                          onPointerDown={(event) =>
                            begin(event, original, "right")
                          }
                          onPointerMove={move}
                          onPointerUp={finish}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => trimWithKeyboard(event, original, "end")}
                        />
                      </div>
                    );
                  })}
                {!drag && (junctionsByTrack.get(track.id) ?? [])
                  .filter(({ after }) => inView(after.start, after.start + after.duration))
                  .map((junction) => {
                    const { before, after } = junction;
                    const transition = after.transitionIn?.duration ? after.transitionIn : null;
                    const overlap = Math.max(0, Math.min(before.start + before.duration, after.start + after.duration) - after.start);
                    const limit = maxTransitionDuration(junction, project.fps);
                    const types = (track.kind === "audio" ? ["fade"] : Object.keys(transitionLabels)) as TransitionType[];
                    const open = transitionEdit === after.id;
                    return (
                      <Fragment key={`junction-${after.id}`}>
                        {overlap > 0 && <i className={`clip-overlap ${transition ? "has-transition" : ""}`} aria-hidden="true" style={{ left: after.start * zoom, width: Math.max(2, overlap * zoom) }} />}
                        <button
                          className={`clip-junction ${transition ? "has-transition" : ""}`}
                          style={{ left: (after.start + overlap / 2) * zoom }}
                          aria-label={`${before.name} → ${after.name} 전환${transition ? ` · ${transitionLabels[transition.type] ?? transition.type}` : ""}`}
                          aria-expanded={open}
                          title={transition
                            ? `${transitionLabels[transition.type] ?? transition.type} · ${transition.duration.toFixed(2)}초 · 눌러서 변경`
                            : overlap > 0 ? "겹친 구간 · 눌러서 전환 추가" : "전환 추가"}
                          disabled={track.locked}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => { event.stopPropagation(); setTransitionEdit(open ? null : after.id); }}
                        >
                          {transition ? <MoveHorizontal size={10} aria-hidden="true" /> : <Plus size={10} aria-hidden="true" />}
                        </button>
                        {open && (
                          <div className="transition-popover" role="group" aria-label="클립 사이 전환" style={{ left: after.start * zoom }}
                            onPointerDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Escape") setTransitionEdit(null);
                            }}>
                            <select aria-label="전환 종류" autoFocus value={transition?.type ?? ""}
                              onChange={(event) => {
                                const type = event.target.value;
                                if (!type) { applyTransition(junction, null); setTransitionEdit(null); }
                                else applyTransition(junction, { type, duration: transition?.duration ?? Math.min(0.5, limit) });
                              }}>
                              <option value="">전환 없음</option>
                              {types.map((type) => <option key={type} value={type} disabled={limit < 1 / project.fps}>{transitionLabels[type]}</option>)}
                            </select>
                            <label>
                              <input aria-label="전환 길이(초)" type="number" min={+(1 / project.fps).toFixed(3)} max={+limit.toFixed(2)} step={0.1}
                                key={transition?.duration ?? 0} defaultValue={transition ? +transition.duration.toFixed(2) : ""} disabled={!transition}
                                onBlur={(event) => {
                                  const value = Number(event.target.value);
                                  if (transition && Number.isFinite(value) && value > 0 && Math.abs(value - transition.duration) > 1e-3)
                                    applyTransition(junction, { type: transition.type, duration: value });
                                }}
                                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
                              초
                            </label>
                            <button title="전환 제거" aria-label="전환 제거" disabled={!transition}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => { applyTransition(junction, null); setTransitionEdit(null); }}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
              </div>
            ))}
            {!project.clips.length && (
              <div className="timeline-empty">
                소재를 여기로 드래그하거나 라이브러리에서 추가하세요
              </div>
            )}
            {project.markers.map((marker) => (
              <i className="timeline-marker-line" key={marker.id} aria-hidden="true" style={{ left: marker.time * zoom }} />
            ))}
            <Playhead zoom={zoom} fixed={fixedTime} scrub={scrub} />
          </div>
        </div>
      </div>
      {shortcuts && (
        <div className="shortcut-popover" role="dialog" aria-label="단축키" id={shortcutsId} ref={shortcutPopover} tabIndex={-1} style={shortcuts}>
          <dl>
            {SHORTCUTS.map(([keys, action]) => (
              <div key={keys}>
                <dt>{keys}</dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
    </section>
  );
}
