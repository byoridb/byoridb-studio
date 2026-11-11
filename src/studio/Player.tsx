import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  LoaderCircle,
  Maximize,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Clip, Command, Media, Project } from "./types";
import { durationOf, timecode } from "./types";
import { assetUrl } from "./api";
import { usePreviewFrame } from "./usePreviewFrame";
import "./preview.css";
import { useProjectFonts } from "./assetCatalog";
import SelectionOverlay, { type LiveTransform } from "./SelectionOverlay";
import { MediaPlayback, primePreviewPlayback } from "./mediaPlayback";
import { canvasTransformPatch } from "./clipEditing";
import { playbackClock, useClockTime } from "./playbackClock";
import {
  animatedValue,
  blendModeStyle,
  cropLayout,
  maskStyle,
  textStyle,
  transitionEffect,
} from "./fastPreview";

export { animatedValue };

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** The real frame ratio, e.g. 1920×1080 → 16:9, 1440×1080 → 4:3. */
export const aspectLabel = (width: number, height: number) => {
  const divisor = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
};

/** Media elements exist only for clips at or near the playhead. */
export const MOUNT_AHEAD = 5;
export const MOUNT_BEHIND = 1;
export interface LoopRange {
  start: number;
  end: number;
}
const VOLUME_KEY = "byori.player.volume";
const storedVolume = () => {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY) ?? "1");
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  } catch {
    return 1;
  }
};
const ZOOMS = [0.25, 0.5, 1, 2];

function MediaElement({
  clip,
  time,
  seekEpoch = 0,
  playing,
  muted,
  master = 1,
  active = true,
  source,
  proxy = false,
  className,
  style,
  onEnded,
  onError,
  onNotice,
}: {
  clip: Clip;
  time: number;
  seekEpoch?: number;
  playing: boolean;
  muted: boolean;
  /** Player volume applied on top of the clip's own level. */
  master?: number;
  active?: boolean;
  source?: string;
  /** A lighter playback copy exists; the original is used again if it fails to load. */
  proxy?: boolean;
  className?: string;
  style?: CSSProperties;
  onEnded?: () => void;
  onError: (message: string) => void;
  /** A problem that leaves playback running. */
  onNotice?: (message: string) => void;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const transport = useRef<MediaPlayback | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const noticeHandler = useRef(onNotice);
  noticeHandler.current = onNotice;
  const [proxyFailed, setProxyFailed] = useState(false);
  const useProxy = proxy && !proxyFailed && !source && clip.kind === "video";
  const url = source || assetUrl(clip.mediaId!, useProxy ? "proxy" : false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const controller = new MediaPlayback(el, (message) => {
      if (useProxy) setProxyFailed(true);
      else errorHandler.current(`${clip.name}: ${message}`);
    }, (message) => noticeHandler.current?.(`${clip.name}: ${message}`));
    transport.current = controller;
    return () => { controller.dispose(); transport.current = null; };
  }, [url, clip.kind]);
  useEffect(() => {
    const local = Math.max(0, time - clip.start);
    const target =
      clip.sourceIn +
      (clip.reverse ? Math.max(0, clip.duration - local) : local) * clip.speed;
    const fade = Math.min(
      1,
      clip.fadeIn > 0 ? local / clip.fadeIn : 1,
      clip.fadeOut > 0 ? (clip.duration - local) / clip.fadeOut : 1,
    );
    const volume = muted
      ? 0
      : Math.max(
          0,
          Math.min(1, animatedValue(clip, "volume", local, clip.volume) * fade * master),
        );
    transport.current?.update({ time, target, seekEpoch, speed: clip.speed, volume, playing, active, reverse: clip.reverse });
  }, [time, seekEpoch, clip, playing, muted, master, active, url]);
  if (clip.kind === "image")
    return <img src={url} draggable={false} alt="" style={style} />;
  const soon = active || (clip.start >= time && clip.start - time <= 3);
  if (clip.kind === "audio")
    return <audio ref={ref} src={url} preload={soon ? "auto" : "metadata"} data-clip-id={clip.id} onEnded={onEnded} />;
  return (
    <video ref={ref} src={url} playsInline preload={soon ? "auto" : "metadata"} className={className} style={style} data-clip-id={clip.id} onEnded={onEnded}
      onError={useProxy ? () => setProxyFailed(true) : undefined} />
  );
}
const renderedClip: Clip = { id: "rendered-preview", kind: "video", trackId: "preview", name: "정밀 미리보기", start: 0, duration: 0, sourceIn: 0, speed: 1, reverse: false, volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [] };

export default function Player({
  project,
  time: fixedTime,
  seekEpoch: fixedEpoch,
  playing,
  onTime,
  onPlaying,
  selectedId,
  onSelect,
  onCommand,
  playbackUrl,
  preparing,
  draftActive = false,
  previewMode = "fast",
  onPreviewMode,
  loop = null,
  onLoop,
}: {
  project: Project;
  /** A fixed time for embedding; by default the player follows the playback clock. */
  time?: number;
  seekEpoch?: number;
  playing: boolean;
  onTime: (n: number) => void;
  onPlaying: (v: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCommand: Command;
  playbackUrl?: string | null;
  preparing?: boolean;
  draftActive?: boolean;
  previewMode?: "fast" | "precise";
  onPreviewMode?: (mode: "fast" | "precise") => void;
  /** The repeated range; playback wraps from its end to its start. */
  loop?: LoopRange | null;
  onLoop?: (range: LoopRange | null) => void;
}) {
  useProjectFonts(project);
  const clockTime = useClockTime();
  const time = fixedTime ?? clockTime;
  const seekEpoch = fixedEpoch ?? playbackClock.epoch();
  const viewport = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ width: 640, height: 360 });
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(storedVolume);
  const changeVolume = (value: number) => {
    setVolume(value);
    setMuted(false);
    try { localStorage.setItem(VOLUME_KEY, String(value)); } catch { /* private mode */ }
  };
  const [drag, setDrag] = useState<{
    id: string;
    x: number;
    y: number;
    originX: number;
    originY: number;
    dx: number;
    dy: number;
    revision: number;
  } | null>(null);
  const [playbackError, setPlaybackError] = useState("");
  const playbackFailed = (message: string) => { setPlaybackError(message); onPlaying(false); };
  useEffect(() => setPlaybackError(""), [project.id]);
  const selectedText = useRef<HTMLDivElement>(null);
  const [liveTransform, setLiveTransform] = useState<LiveTransform | null>(
    null,
  );
  const [textBounds, setTextBounds] = useState({ width: 100, height: 30 });
  // Fullscreen shows the frame alone, so it always fits the screen.
  const size = zoom === "fit" || fullscreen
    ? fit
    : { width: project.width * zoom, height: project.height * zoom };
  useLayoutEffect(() => {
    if (selectedText.current)
      setTextBounds({
        width: selectedText.current.offsetWidth,
        height: selectedText.current.offsetHeight,
      });
    setLiveTransform(null);
  }, [selectedId, project.revision, size.width]);
  const frame = usePreviewFrame(
    project,
    time,
    size.width,
    !playing &&
      !drag &&
      !liveTransform &&
      !draftActive &&
      !playbackUrl &&
      !!project.clips.length,
  );
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = (width: number, height: number) => {
      // The fullscreen element is the viewport itself: no panel margins there.
      const margin = document.fullscreenElement === element ? 0 : 1;
      const s = Math.min(
        (width - 48 * margin) / project.width,
        (height - 40 * margin) / project.height,
      );
      setFit({
        width: Math.max(1, project.width * s),
        height: Math.max(1, project.height * s),
      });
    };
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      measure(r.width, r.height);
    });
    observer.observe(element);
    const change = () => {
      setFullscreen(document.fullscreenElement === element);
      const r = element.getBoundingClientRect();
      if (r.width && r.height) measure(r.width, r.height);
    };
    document.addEventListener("fullscreenchange", change);
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", change);
    };
  }, [project.width, project.height]);
  const scale = size.width / project.width;
  const { ordered, trackOf, mediaOf } = useMemo(() => {
    const trackIndex = new Map(project.tracks.map((track, index) => [track.id, index]));
    const trackOf = new Map(project.tracks.map((track) => [track.id, track]));
    const mediaOf = new Map<string, Media>(project.media.map((media) => [media.id, media]));
    // Tracks stack in order; within a track the later clip sits on top of an
    // overlapping earlier one (array order breaks ties), as in the export.
    const ordered = project.clips
      .map((clip, index) => ({ clip, index }))
      .sort((a, b) =>
        (trackIndex.get(a.clip.trackId) ?? -1) - (trackIndex.get(b.clip.trackId) ?? -1) ||
        a.clip.start - b.clip.start ||
        a.index - b.index)
      .map((entry) => entry.clip);
    return { ordered, trackOf, mediaOf };
  }, [project.clips, project.tracks, project.media]);
  const isActive = (clip: Clip) => time >= clip.start && time < clip.start + clip.duration;
  const selectedClip = selectedId ? project.clips.find((c) => c.id === selectedId) : undefined;
  const selectedVisual =
    selectedClip &&
    isActive(selectedClip) &&
    selectedClip.kind !== "audio" &&
    !trackOf.get(selectedClip.trackId)?.hidden
      ? selectedClip
      : undefined;
  const selectedLayout = selectedVisual && selectedVisual.kind !== "text"
    ? cropLayout(mediaOf.get(selectedVisual.mediaId ?? "") ?? project, selectedVisual.crop, size)
    : null;
  const selectionBox =
    selectedVisual?.kind === "text"
      ? textBounds
      : selectedLayout?.frame ?? size;
  const total = durationOf(project);
  const live = (clip: Clip) => (liveTransform && selectedId === clip.id ? liveTransform : null);
  const setLoopEdge = (edge: "start" | "end") => {
    if (!onLoop) return;
    const at = Math.max(0, Math.min(total, time));
    const range = loop ?? { start: 0, end: total };
    const next = edge === "start"
      ? { start: at, end: range.end > at ? range.end : total }
      : { start: range.start < at ? range.start : 0, end: at };
    onLoop(next.end - next.start >= 1 / project.fps ? next : null);
  };
  return (
    <section className="player-panel" aria-label="영상 미리보기">
      <div className="panel-heading">
        <span>플레이어</span>
        {onPreviewMode && (
          <select
            className="preview-mode"
            aria-label="미리보기 모드"
            title="빠른 재생은 즉시 시작합니다. LUT·크로마키·곡선·오디오 효과·역재생 등은 정밀 재생에서 확인하세요."
            value={previewMode}
            onChange={(event) =>
              onPreviewMode(event.target.value as "fast" | "precise")
            }
          >
            <option value="fast">빠른 재생</option>
            <option value="precise">정밀 재생</option>
          </select>
        )}
        {!playbackUrl && (!frame || playing || draftActive) && (
          <span
            className="preview-draft-badge"
            title="일부 색상·크로마키·LUT·오디오 효과는 정밀 재생에서 확인하세요."
          >
            간편 미리보기
          </span>
        )}
        <span className="heading-meta">
          {project.width} × {project.height}{" "}
          <span className="small-divider">/</span> {project.fps} fps
        </span>
      </div>
      <div className={`player-viewport ${zoom !== "fit" && !fullscreen ? "zoomed" : ""}`} ref={viewport}>
        {/* The frame clips its layers; selection handles sit beside it so they may reach past the edge. */}
        <div className="composition-frame">
        <div
          className="composition"
          style={{
            width: size.width,
            height: size.height,
            background: project.background || "#000",
          }}
        >
          {ordered.map((original) => {
            const sourceMedia = mediaOf.get(original.mediaId ?? "");
            const clip = sourceMedia?.kind === "audio" && original.kind !== "audio" ? { ...original, kind: "audio" as const } : original;
            const track = trackOf.get(clip.trackId);
            const active = isActive(clip);
            const timed = clip.kind === "video" || clip.kind === "audio";
            // Stills and text exist only while shown; timed media also mounts
            // shortly before its cut so it is decoded and seeked in time.
            if (timed
              ? time < clip.start - MOUNT_AHEAD || time >= clip.start + clip.duration + MOUNT_BEHIND
              : !active || track?.hidden) return null;
            if (clip.kind === "audio")
              return (
                <MediaElement
                  key={clip.id}
                  clip={clip}
                  time={time}
                  seekEpoch={seekEpoch}
                  playing={playing && !playbackUrl}
                  muted={muted || !!playbackUrl || !!track?.muted}
                  master={volume}
                  active={active}
                  onError={playbackFailed}
                  onNotice={setPlaybackError}
                />
              );
            const local = time - clip.start;
            const t = clip.transform;
            const c = clip.color;
            const moving = live(clip);
            const x =
              moving
                ? moving.x
                : drag?.id === clip.id
                  ? drag.originX + drag.dx
                  : animatedValue(clip, "x", local, t.x);
            const y =
              moving
                ? moving.y
                : drag?.id === clip.id
                  ? drag.originY + drag.dy
                  : animatedValue(clip, "y", local, t.y);
            const layout = clip.kind === "text" ? null : cropLayout(sourceMedia, clip.crop, size);
            const drawnScale = moving ? moving.scale : animatedValue(clip, "scale", Math.max(0, local), t.scale);
            const effect = transitionEffect(
              clip,
              Math.max(0, local),
              project.width,
              layout ? (layout.frame.width / scale) * drawnScale : undefined,
              x,
            );
            const flip = `scale(${t.flipX ? -1 : 1},${t.flipY ? -1 : 1})`;
            const mask = maskStyle(clip.mask);
            const style: CSSProperties = {
              transform: `translate(${(x + effect.x) * scale}px,${(y + effect.y) * scale}px) scale(${(moving ? moving.scale : animatedValue(clip, "scale", local, t.scale)) * effect.scale}) rotate(${moving?.rotation ?? animatedValue(clip, "rotation", local, t.rotation)}deg)${layout ? "" : ` ${flip}`}`,
              opacity: animatedValue(clip, "opacity", local, t.opacity) * effect.opacity,
              filter: `brightness(${1 + c.brightness}) contrast(${c.contrast}) saturate(${c.saturation}) ${c.temperature > 0 ? `sepia(${c.temperature * 0.3})` : ""}`,
              mixBlendMode: blendModeStyle(clip),
              display: !active || track?.hidden ? "none" : undefined,
            };
            const element = clip.kind === "text" ? null : (
              <MediaElement
                clip={clip}
                time={time}
                seekEpoch={seekEpoch}
                playing={playing && !playbackUrl}
                muted={muted || !!playbackUrl || !!track?.muted}
                master={volume}
                active={active}
                proxy={!!sourceMedia?.proxy}
                style={layout ? {
                  position: "absolute",
                  left: layout.media.left,
                  top: layout.media.top,
                  width: layout.media.width,
                  height: layout.media.height,
                  maxWidth: "none",
                  objectFit: "fill",
                  // Flip about the centre of the cropped frame, like the export.
                  transform: t.flipX || t.flipY ? flip : undefined,
                  transformOrigin: `${-layout.media.left + layout.frame.width / 2}px ${-layout.media.top + layout.frame.height / 2}px`,
                } : undefined}
                onError={playbackFailed}
                onNotice={setPlaybackError}
              />
            );
            // A wipe crops the clip's own picture, as in the export.
            const wipeOnFrame = !!effect.clipPath && (clip.kind === "text" || !!layout);
            if (effect.clipPath && !wipeOnFrame) style.clipPath = effect.clipPath;
            return (
              <div
                className={`composition-layer  ${clip.kind === "text" ? "text-layer" : ""}`}
                key={clip.id}
                data-layer-id={clip.id}
                style={style}
                onPointerDown={(e) => {
                  if (track?.locked) return;
                  e.stopPropagation();
                  onSelect(clip.id);
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({
                    id: clip.id,
                    x: e.clientX,
                    y: e.clientY,
                    originX: animatedValue(clip, "x", local, t.x),
                    originY: animatedValue(clip, "y", local, t.y),
                    dx: 0,
                    dy: 0,
                    revision: project.revision,
                  });
                }}
                onPointerMove={(e) => {
                  if (drag?.id === clip.id)
                    setDrag({
                      ...drag,
                      dx: (e.clientX - drag.x) / scale,
                      dy: (e.clientY - drag.y) / scale,
                    });
                }}
                onPointerUp={() => {
                  if (
                    drag?.id === clip.id &&
                    (Math.abs(drag.dx) > 1 || Math.abs(drag.dy) > 1)
                  )
                    void onCommand("edit.update", {
                      id: clip.id,
                      expectedRevision: drag.revision,
                      patch: canvasTransformPatch(
                        original,
                        {
                          x: Math.round(drag.originX + drag.dx),
                          y: Math.round(drag.originY + drag.dy),
                        },
                        time,
                        project.fps,
                      ),
                    });
                  setDrag(null);
                }}
                onPointerCancel={() => setDrag(null)}
              >
                {clip.kind === "text" ? (
                  <div
                    ref={selectedId === clip.id ? selectedText : undefined}
                    style={{
                      ...textStyle(clip.text, scale, project.width),
                      clipPath: wipeOnFrame ? effect.clipPath : undefined,
                    }}
                  >
                    {clip.text?.content}
                  </div>
                ) : layout && effect.clipPath && mask.clipPath ? (
                  // Two clip paths: the wipe on the picture's box, the mask inside it.
                  <div className="layer-wipe" style={{ clipPath: effect.clipPath }}>
                    <div className="layer-frame" style={{ width: layout.frame.width, height: layout.frame.height, ...mask }}>
                      {element}
                    </div>
                  </div>
                ) : layout ? (
                  <div
                    className="layer-frame"
                    style={{
                      width: layout.frame.width,
                      height: layout.frame.height,
                      ...mask,
                      ...(wipeOnFrame ? { clipPath: effect.clipPath } : {}),
                    }}
                  >
                    {element}
                  </div>
                ) : (
                  element
                )}
              </div>
            );
          })}
          {playbackUrl && !drag && !liveTransform && !draftActive && (
            <MediaElement
              className="rendered-preview"
              source={playbackUrl}
              clip={{ ...renderedClip, duration: total }}
              time={time}
              seekEpoch={seekEpoch}
              playing={playing}
              muted={muted}
              master={volume}
              onError={playbackFailed}
              onNotice={setPlaybackError}
              // The decoder can reach the end before the clock does: a repeat wraps.
              onEnded={() => (loop ? onTime(loop.start) : onPlaying(false))}
            />
          )}
          {!playing &&
            !playbackUrl &&
            !drag &&
            !liveTransform &&
            !draftActive &&
            frame && (
              <img
                className="rendered-preview"
                src={frame.url}
                onError={frame.retry}
                alt="최종 렌더 미리보기"
              />
            )}
          {liveTransform?.guides?.x !== undefined && (
            <i className="snap-guide vertical" style={{ left: Math.min(size.width - 1, (project.width / 2 + liveTransform.guides.x) * scale) }} />
          )}
          {liveTransform?.guides?.y !== undefined && (
            <i className="snap-guide horizontal" style={{ top: Math.min(size.height - 1, (project.height / 2 + liveTransform.guides.y) * scale) }} />
          )}
          {!project.clips.length && (
            <div className="player-empty">
              <span>이야기가 시작되는 곳</span>
              <p>소재를 타임라인에 추가해 주세요.</p>
            </div>
          )}
        </div>
          {selectedVisual &&
            !playing &&
            !fullscreen &&
            !trackOf.get(selectedVisual.trackId)?.locked && (
              <SelectionOverlay
                clip={selectedVisual}
                revision={project.revision}
                box={selectionBox}
                ratio={scale}
                stage={project}
                rotation={liveTransform?.rotation ?? animatedValue(
                  selectedVisual,
                  "rotation",
                  time - selectedVisual.start,
                  selectedVisual.transform.rotation,
                )}
                transform={
                  liveTransform || {
                    x: animatedValue(
                      selectedVisual,
                      "x",
                      time - selectedVisual.start,
                      selectedVisual.transform.x,
                    ),
                    y: animatedValue(
                      selectedVisual,
                      "y",
                      time - selectedVisual.start,
                      selectedVisual.transform.y,
                    ),
                    scale: animatedValue(
                      selectedVisual,
                      "scale",
                      time - selectedVisual.start,
                      selectedVisual.transform.scale,
                    ),
                  }
                }
                time={time}
                fps={project.fps}
                onPreview={setLiveTransform}
                onCommand={onCommand}
              />
            )}
        </div>
      </div>
      {playbackError && <div className="preview-playback-error" role="alert">{playbackError}</div>}
      <div className="player-controls">
        <div className="player-time">
          <span>{timecode(time, project.fps)}</span>
          <span> / {timecode(total, project.fps)}</span>
        </div>
        <div className="transport">
          <button
            title="이전 프레임 (←)"
            onClick={() => onTime(Math.max(0, time - 1 / project.fps))}
          >
            <SkipBack size={15} />
          </button>
          <button
            className="play-button"
            title={
              preparing
                ? "미리보기 준비 취소"
                : playing
                  ? "일시정지 (Space)"
                  : "재생 (Space)"
            }
            onClick={() => {
              if (!playing && !preparing) { setPlaybackError(""); primePreviewPlayback(); }
              onPlaying(!playing && !preparing);
            }}
            disabled={!total}
          >
            {preparing ? (
              <LoaderCircle className="spin" size={20} />
            ) : playing ? (
              <Pause size={20} />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </button>
          <button
            title="다음 프레임 (→)"
            onClick={() => onTime(Math.min(total, time + 1 / project.fps))}
          >
            <SkipForward size={15} />
          </button>
        </div>
        <div className="player-options">
          {onLoop && (
            <div className="player-loop" role="group" aria-label="구간 반복">
              <button title="반복 시작점을 재생 헤드로 (I)" aria-label="반복 시작점 지정" disabled={!total} onClick={() => setLoopEdge("start")}>I</button>
              <button title="반복 끝점을 재생 헤드로 (O)" aria-label="반복 끝점 지정" disabled={!total} onClick={() => setLoopEdge("end")}>O</button>
              <button
                className={loop ? "active" : ""}
                aria-pressed={!!loop}
                aria-label="구간 반복"
                title={loop
                  ? `구간 반복 끄기 · ${timecode(loop.start, project.fps)} – ${timecode(loop.end, project.fps)}`
                  : "전체 구간 반복 켜기"}
                disabled={!total}
                onClick={() => onLoop(loop ? null : { start: 0, end: total })}
              >
                <Repeat size={14} />
              </button>
            </div>
          )}
          <button
            title={muted || !volume ? "소리 켜기" : "소리 끄기"}
            onClick={() => (volume ? setMuted(!muted) : changeVolume(1))}
          >
            {muted || !volume ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input
            className="player-volume"
            type="range"
            aria-label="미리보기 음량"
            title={`미리보기 음량 ${Math.round((muted ? 0 : volume) * 100)}% · 내보내기에는 영향을 주지 않습니다`}
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(event) => changeVolume(+event.target.value)}
          />
          <select
            className="player-zoom"
            aria-label="미리보기 확대"
            title={`미리보기 확대 · 화면 비율 ${aspectLabel(project.width, project.height)}`}
            value={String(zoom)}
            onChange={(event) => setZoom(event.target.value === "fit" ? "fit" : +event.target.value)}
          >
            <option value="fit">맞춤</option>
            {ZOOMS.map((value) => <option key={value} value={value}>{value * 100}%</option>)}
          </select>
          <span className="ratio-label">
            {aspectLabel(project.width, project.height)}
          </span>
          <button
            title="미리보기 전체 화면"
            onClick={() => {
              void viewport.current?.requestFullscreen?.();
            }}
          >
            <Maximize size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}
