import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
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
import type { Clip, Command, Project, Track } from "./types";
import { durationOf, timecode } from "./types";
import { assetUrl } from "./api";
import { clipEditCommands, trimClipPreview, waveformBars, waveformRange, type ClipEditAction } from "./clipEditing";
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
const trackNames: Record<Track["kind"], string> = { video: "영상", audio: "오디오", text: "자막·텍스트" };

// These visuals do not change as the playhead moves. Keep their DOM work out
// of the playback clock while leaving all editing handlers on the live parent.
const ClipVisual = memo(function ClipVisual({ kind, thumbnail, waveform, from = 0, to, reverse, text }: {
  kind: Clip["kind"];
  thumbnail?: string;
  waveform?: number[];
  from?: number;
  to?: number;
  reverse?: boolean;
  text?: string;
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
  return <div className="clip-text-preview">{text}</div>;
});

const RulerTicks = memo(function RulerTicks({ length, step, zoom }: {
  length: number;
  step: number;
  zoom: number;
}) {
  return <>{Array.from({ length: Math.ceil(length / step) + 1 }, (_, index) => (
    <span key={index} style={{ left: index * step * zoom }}>
      {Math.floor((index * step) / 60).toString().padStart(2, "0")}
      :{((index * step) % 60).toString().padStart(2, "0")}
    </span>
  ))}</>;
});

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
  time: number;
  onTime: (value: number) => void;
  selectedId: string | null;
  selectedIds: string[];
  selectedTrackId?: string | null;
  onTrackSelect?: (id: string) => void;
  onSelection: (ids: string[], primary?: string | null) => void;
  onCommand: Command;
  history: { canUndo: boolean; canRedo: boolean };
  playing?: boolean;
}
const MIN_ZOOM = 0.1, MAX_ZOOM = 180;
const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
const sliderOf = (zoom: number) => Math.round(Math.log(zoom) * 100);
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const EDGE = 36;
const DRAG_THRESHOLD = 4;
export default function Timeline({
  project,
  time,
  onTime,
  selectedId,
  selectedIds,
  selectedTrackId,
  onTrackSelect,
  onSelection,
  onCommand,
  history,
  playing = false,
}: TimelineProps) {
  const [zoom, setZoom] = useState(68);
  const [markerEdit, setMarkerEdit] = useState<string | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const zoomAnchor = useRef<{ time: number; x: number } | null>(null);
  const labelsWidth = () => labels.current?.offsetWidth ?? 0;
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const activeDrag = useRef<Drag | null>(null);
  const trackRows = useRef(new Map<string, HTMLDivElement>());
  const editGuideId = useId();
  const editable = canEditSelection(project, selectedIds);
  const selection = selectedClips(project, selectedIds);
  const cuts = clipEditCommands(project, selectedIds, time, "split");
  const selectionKind = selection.length && selection.every((clip) => trackKindForClip(clip) === trackKindForClip(selection[0]))
    ? trackKindForClip(selection[0]) : null;
  const duration = durationOf(project);
  const length = Math.max(duration + 3, 15);
  const width = Math.max(800, length * zoom);
  const step = RULER_STEPS.find((seconds) => seconds * zoom >= 56) ?? RULER_STEPS[RULER_STEPS.length - 1];
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
    const element = workspace.current;
    if (!playing || !element) return;
    const view = element.clientWidth - labelsWidth();
    const x = time * zoom;
    if (view > 0 && (x < element.scrollLeft || x > element.scrollLeft + view - 24))
      element.scrollLeft = Math.max(0, x - 24);
  }, [playing, time, zoom]);
  const fitZoom = () => {
    const view = (workspace.current?.clientWidth ?? 0) - labelsWidth() - 24;
    setZoom(clampZoom((view > 0 ? view : 800) / Math.max(duration, 1)));
    if (workspace.current) workspace.current.scrollLeft = 0;
  };
  const run = (method: string, params: Record<string, unknown> = {}) =>
    onCommand(method, { ...params, expectedRevision: project.revision }).catch(
      () => undefined,
    );
  const editAtPlayhead = async (action: ClipEditAction) => {
    const commands = clipEditCommands(project, selectedIds, time, action);
    const result = commands.length === 1
      ? await run(commands[0].method, commands[0].params)
      : commands.length > 1 ? await run("edit.batch", { commands }) : undefined;
    if (action === "split") {
      const ids = newClipIds(project, result);
      if (ids.length) onSelection(ids, ids[ids.length - 1]);
    }
  };
  const createTrack = async (kind: Track["kind"], clipIds?: string[]) => {
    const result = await run("edit.track", {
      kind,
      name: `${trackNames[kind]} ${project.tracks.filter((track) => track.kind === kind).length + 1}`,
      ...(clipIds?.length ? { clipIds } : {}),
    });
    if (result && typeof result === "object" && "tracks" in result && Array.isArray(result.tracks)) {
      const added = (result.tracks as Track[]).find((track) => !project.tracks.some((existing) => existing.id === track.id));
      if (added) onTrackSelect?.(added.id);
    }
  };
  const moveToTrack = (trackId: string) => {
    if (!editable || !selectionKind) return;
    if (trackId === "new") { void createTrack(selectionKind, selectedIds); return; }
    const commands = moveSelectionToTrack(project, selectedIds, trackId);
    if (commands.length) void run("edit.batch", { commands }).then((result) => {
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
      time,
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
  const scrub = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      scrubbing.current = true;
      press(event);
      seek(event);
      edgeScroll();
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (!scrubbing.current || !travelled(event)) return;
      seek(event);
    },
    onPointerUp: () => { scrubbing.current = false; },
    onPointerCancel: () => { scrubbing.current = false; },
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
    setActiveDrag({
      id: clip.id,
      mode,
      x: event.clientX,
      origin: clip,
      clips: mode === "move" ? selectedClips(project, ids) : [clip],
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
    if (current.mode === "move")
      void onCommand("edit.batch", {
        commands,
        expectedRevision: current.revision,
      }).then((result) => {
        if (result && current.targetTrack) onTrackSelect?.(current.targetTrack);
      }).catch(() => undefined);
    else {
      const clip = { ...current.origin, ...current.previews[current.id] };
      void onCommand("edit.trim", {
        id: clip.id,
        start: clip.start,
        end: clip.start + clip.duration,
        expectedRevision: current.revision,
      }).catch(() => undefined);
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
    const target = (edge === "start" ? clip.start : clip.start + clip.duration)
      + (event.key === "ArrowRight" ? 1 : -1) / project.fps;
    const preview = trimClipPreview(project, clip, edge, target);
    if (!preview) return;
    const trimmed = { ...clip, ...preview };
    void run("edit.trim", { id: clip.id, start: trimmed.start, end: trimmed.start + trimmed.duration });
  };
  const duplicate = async () => {
    const result = await run("edit.duplicate", { ids: selectedIds });
    const ids = newClipIds(project, result);
    if (ids.length) onSelection(ids, ids[ids.length - 1]);
  };
  const remove = async (ripple = false) => {
    const result = await run("edit.delete", { ids: selectedIds, ripple });
    if (result) onSelection([], null);
  };
  const trimming = drag && drag.mode !== "move"
    ? { ...drag.origin, ...drag.previews[drag.id] } : null;
  const editGuide = !selection.length
    ? "클립을 선택하고 재생 헤드를 자를 위치로 옮기세요"
    : !editable
      ? "트랙 잠금을 해제하면 클립을 편집할 수 있어요"
      : !cuts.length
        ? "재생 헤드를 클립 안으로 옮기세요 · 양쪽 1프레임 이상"
        : `${cuts.length > 1 ? `${cuts.length}개 클립 · ` : ""}재생 헤드에서 자르기 · 양끝 손잡이로 길이 조절`;
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
            onClick={() => void run("edit.group", { ids: selectedIds })}
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
            onClick={() => void run("edit.ungroup", { ids: selectedIds })}
          >
            <Unlink2 size={16} />
          </button>
          <i />
          <button
            title="마커 추가 (M)"
            onClick={() =>
              void run("edit.marker", {
                time,
                label: `마커 ${project.markers.length + 1}`,
              })
            }
          >
            <Flag size={16} />
          </button>
          <select className="timeline-track-select" aria-label="트랙 추가" value="" onChange={(event) => void createTrack(event.target.value as Track["kind"])}>
            <option value="" disabled>트랙 추가</option>
            <option value="video">영상 트랙 추가</option>
            <option value="audio">오디오 트랙 추가</option>
            <option value="text">자막·텍스트 트랙 추가</option>
          </select>
          <select className="timeline-track-select" aria-label="선택 클립 트랙 이동" title={!selectionKind && selection.length ? "같은 종류의 클립을 선택해 이동하세요" : "시각을 유지하며 다른 트랙으로 이동"}
            value="" disabled={!editable || !selectionKind} onChange={(event) => moveToTrack(event.target.value)}>
            <option value="" disabled>트랙 이동</option>
            <option value="new">새 트랙으로 분리</option>
            {project.tracks.filter((track) => track.kind === selectionKind).map((track) => <option key={track.id} value={track.id} disabled={track.locked || selection.every((clip) => clip.trackId === track.id)}>{track.name}{track.locked ? " · 잠김" : ""}</option>)}
          </select>
        </div>
        <div className="timeline-title">
          타임라인{" "}
          <span>
            {selectedIds.length
              ? `${selectedIds.length}개 선택`
              : `${project.clips.length} clips`}
          </span>
        </div>
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
        </div>
      </div>
      <div className="timeline-editbar" role="group" aria-label="클립 편집">
        <button title="나누기 (⌘B)" aria-describedby={editGuideId} disabled={!cuts.length || !!drag}
          onClick={() => editAtPlayhead("split")}>
          <Scissors size={14} aria-hidden="true" /> 나누기 <kbd aria-hidden="true">⌘B</kbd>
        </button>
        <button title="앞부분 자르기 (Q)" aria-describedby={editGuideId} disabled={!cuts.length || !!drag}
          onClick={() => editAtPlayhead("trim-start")}>
          <ArrowLeftToLine size={14} aria-hidden="true" /> 앞부분 자르기 <kbd aria-hidden="true">Q</kbd>
        </button>
        <button title="뒷부분 자르기 (W)" aria-describedby={editGuideId} disabled={!cuts.length || !!drag}
          onClick={() => editAtPlayhead("trim-end")}>
          <ArrowRightToLine size={14} aria-hidden="true" /> 뒷부분 자르기 <kbd aria-hidden="true">W</kbd>
        </button>
        <span className={`timeline-edit-guide ${trimming ? "trimming" : ""}`} id={editGuideId} role="status">
          {trimming
            ? `${trimming.name} · ${timecode(trimming.start, project.fps)} → ${timecode(trimming.start + trimming.duration, project.fps)} · 길이 ${trimming.duration.toFixed(2)}초`
            : editGuide}
        </span>
      </div>
      <div className="timeline-workspace" ref={workspace}>
        <div className="track-labels" ref={labels}>
          <div className="track-label-spacer">
            {timecode(time, project.fps)}
          </div>
          {project.tracks.map((track, index) => (
            <div className={`track-label ${track.kind} ${selectedTrackId === track.id ? "active-track" : ""}`} key={track.id}
              onClick={() => onTrackSelect?.(track.id)}>
              <div className="track-name">
                <button className="track-select-button" aria-label={`${track.name} 트랙 선택`} title={`${trackNames[track.kind]} 트랙 선택`}
                  aria-pressed={selectedTrackId === track.id}>
                {track.kind === "text" ? (
                  <Type size={15} />
                ) : track.kind === "audio" ? (
                  <Music2 size={15} />
                ) : (
                  <Film size={15} />
                )}
                </button>
                <TrackName track={track} onRename={(name) => void run("edit.track", { id: track.id, patch: { name } })} />
              </div>
              <div className="track-switches">
                <button
                  title={track.locked ? "트랙 잠금 해제" : "트랙 잠금"}
                  aria-label={`${track.name} 잠금`}
                  onClick={() =>
                    void run("edit.track", {
                      id: track.id,
                      patch: { locked: !track.locked },
                    })
                  }
                >
                  {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
                </button>
                <button
                  title={track.hidden ? "트랙 표시" : "트랙 숨기기"}
                  aria-label={`${track.name} 표시`}
                  onClick={() =>
                    void run("edit.track", {
                      id: track.id,
                      patch: { hidden: !track.hidden },
                    })
                  }
                >
                  {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  title={track.muted ? "음소거 해제" : "음소거"}
                  aria-label={`${track.name} 음소거`}
                  onClick={() =>
                    void run("edit.track", {
                      id: track.id,
                      patch: { muted: !track.muted },
                    })
                  }
                >
                  {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <button title="트랙 위로 이동" aria-label={`${track.name} 위로 이동`} disabled={index === 0}
                  onClick={() => void run("edit.trackMove", { id: track.id, index: index - 1 })}>
                  <ChevronUp size={13} />
                </button>
                <button title="트랙 아래로 이동" aria-label={`${track.name} 아래로 이동`} disabled={index === project.tracks.length - 1}
                  onClick={() => void run("edit.trackMove", { id: track.id, index: index + 1 })}>
                  <ChevronDown size={13} />
                </button>
                <button title={track.locked ? "잠긴 트랙은 삭제할 수 없습니다" : "트랙과 클립 삭제 (실행 취소 가능)"} aria-label={`${track.name} 삭제`} disabled={track.locked}
                  onClick={(event) => { event.stopPropagation(); void run("edit.trackDelete", { id: track.id }); }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="timeline-scroll">
          <div className="timeline-content" ref={content} style={{ width }}>
            <div className="timeline-ruler" {...scrub}>
              <RulerTicks length={length} step={step} zoom={zoom} />
              {project.markers.map((marker) => (
                <button
                  className="timeline-marker"
                  key={marker.id}
                  title={`${marker.label} · 더블클릭해서 이름 변경·삭제`}
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
                >
                  <Flag size={12} />
                </button>
              ))}
              {project.markers.filter((marker) => marker.id === markerEdit).map((marker) => (
                <div className="marker-popover" key={marker.id} style={{ left: marker.time * zoom }}
                  onPointerDown={(event) => event.stopPropagation()}>
                  <input aria-label="마커 이름" defaultValue={marker.label} maxLength={80} autoFocus
                    onBlur={(event) => {
                      const label = event.target.value.trim();
                      if (label && label !== marker.label) void run("edit.markerUpdate", { id: marker.id, label });
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
                    onClick={() => { setMarkerEdit(null); void run("edit.markerDelete", { id: marker.id }); }}>
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
                  seek(event);
                  onSelection([], null);
                  onTrackSelect?.(track.id);
                }}
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
                    void run("edit.add", {
                      mediaId,
                      trackId: track.id,
                      start: snapped((event.clientX - rect.left) / zoom),
                    });
                  }
                }}
              >
                {project.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((original) => {
                    const clip = {
                      ...original,
                      ...drag?.previews[original.id],
                    };
                    const media = project.media.find((item) => item.id === clip.mediaId);
                    const peaks = clip.kind === "audio" ? media?.waveform : undefined;
                    const [from, to] = peaks ? waveformRange(clip, media!.duration, peaks.length) : [0, 0];
                    return (
                      <div
                        key={clip.id}
                        className={`timeline-clip ${clip.kind} ${selectedIds.includes(clip.id) ? "selected" : ""} ${clip.id === selectedId ? "primary-selection" : ""} ${media?.missing ? "missing" : ""}`}
                        title={media?.missing ? "원본 파일을 찾을 수 없습니다" : undefined}
                        style={{
                          left: clip.start * zoom,
                          width: Math.max(8, clip.duration * zoom),
                          ...(drag?.previews[original.id]?.trackId && drag.previews[original.id].trackId !== original.trackId ? {
                            transform: `translateY(${(trackRows.current.get(drag.previews[original.id].trackId!)?.offsetTop || 0) - (trackRows.current.get(original.trackId)?.offsetTop || 0)}px)`,
                            zIndex: 15,
                          } : {}),
                        }}
                        onPointerCancel={() => setActiveDrag(null)}
                      >
                        <div className="clip-body" role="button" tabIndex={0}
                          aria-pressed={selectedIds.includes(clip.id)}
                          aria-label={`${clip.name}, ${clip.start.toFixed(1)}초, ${clip.duration.toFixed(1)}초`}
                          onPointerDown={(event) => begin(event, original, "move")}
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
                          <div className="clip-label">
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
                            text={clip.text?.content}
                          />
                        </div>
                        <button
                          className="clip-trim left"
                          aria-label={`${clip.name} 시작점 트림`}
                          title="시작점 트림 · 드래그 또는 ← →로 1프레임 조절"
                          disabled={track.locked}
                          tabIndex={selectedIds.includes(clip.id) ? 0 : -1}
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
                          tabIndex={selectedIds.includes(clip.id) ? 0 : -1}
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
              </div>
            ))}
            {!project.clips.length && (
              <div className="timeline-empty">
                소재를 여기로 드래그하거나 라이브러리에서 추가하세요
              </div>
            )}
            <div className="playhead" style={{ left: time * zoom }}>
              <div className="playhead-handle" title="드래그해서 탐색" {...scrub} />
            </div>
          </div>
        </div>
      </div>
      <div className="timeline-footer">
        <span title="← → 프레임 이동 · ↑ ↓ 편집점 이동 · ⌥← → 선택 이동 · ⌥↑ ↓ 트랙 이동">
          {selectedIds.length > 1
            ? `${selectedIds.length}개 선택 · ⇧/⌘ 클릭으로 추가 선택`
            : "위아래 드래그로 트랙 이동 · ⇧/⌘ 클릭 다중 선택 · ⌘C/X/V 복사·잘라내기·붙여넣기"}
        </span>
        <span>
          {project.fps} fps <span className="small-divider">·</span> 전체{" "}
          {duration.toFixed(2)}초
        </span>
      </div>
    </section>
  );
}
