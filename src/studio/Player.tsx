import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LoaderCircle,
  Maximize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Clip, Command, Project } from "./types";
import { durationOf, timecode } from "./types";
import { assetUrl } from "./api";
import { usePreviewFrame } from "./usePreviewFrame";
import "./preview.css";
import { useProjectFonts } from "./assetCatalog";
import SelectionOverlay, { type LiveTransform } from "./SelectionOverlay";
import { MediaPlayback, primePreviewPlayback } from "./mediaPlayback";

export function animatedValue(
  clip: Clip,
  property: string,
  time: number,
  fallback: number,
) {
  const keys = (clip.keyframes || [])
    .filter(
      (k) => k.property === property || k.property === `transform.${property}`,
    )
    .sort((a, b) => a.time - b.time);
  if (!keys.length) return fallback;
  if (keys[0].time > 0) keys.unshift({ property, time: 0, value: fallback });
  if (time <= keys[0].time) return keys[0].value;
  for (let i = 1; i < keys.length; i++)
    if (time <= keys[i].time) {
      const p =
        (time - keys[i - 1].time) / (keys[i].time - keys[i - 1].time || 1);
      return keys[i - 1].value + (keys[i].value - keys[i - 1].value) * p;
    }
  return keys[keys.length - 1].value;
}
function MediaElement({
  clip,
  time,
  seekEpoch = 0,
  playing,
  muted,
  active = true,
  source,
  className,
  onEnded,
  onError,
}: {
  clip: Clip;
  time: number;
  seekEpoch?: number;
  playing: boolean;
  muted: boolean;
  active?: boolean;
  source?: string;
  className?: string;
  onEnded?: () => void;
  onError: (message: string) => void;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const transport = useRef<MediaPlayback | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const url = source || assetUrl(clip.mediaId!);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const controller = new MediaPlayback(el, (message) => errorHandler.current(`${clip.name}: ${message}`));
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
          Math.min(1, animatedValue(clip, "volume", local, clip.volume) * fade),
        );
    transport.current?.update({ time, target, seekEpoch, speed: clip.speed, volume, playing, active, reverse: clip.reverse });
  }, [time, seekEpoch, clip, playing, muted, active, url]);
  if (clip.kind === "image")
    return <img src={url} draggable={false} alt="" />;
  if (clip.kind === "audio")
    return <audio ref={ref} src={url} preload={active || (clip.start >= time && clip.start - time <= 3) ? "auto" : "metadata"} data-clip-id={clip.id} onEnded={onEnded} />;
  return (
    <video ref={ref} src={url} playsInline preload="metadata" className={className} data-clip-id={clip.id} onEnded={onEnded} />
  );
}
export default function Player({
  project,
  time,
  seekEpoch = 0,
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
}: {
  project: Project;
  time: number;
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
}) {
  useProjectFonts(project);
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 360 });
  const [muted, setMuted] = useState(false);
  const [drag, setDrag] = useState<{
    id: string;
    x: number;
    y: number;
    originX: number;
    originY: number;
    dx: number;
    dy: number;
  } | null>(null);
  const [playbackError, setPlaybackError] = useState("");
  const playbackFailed = (message: string) => { setPlaybackError(message); onPlaying(false); };
  useEffect(() => setPlaybackError(""), [project.id]);
  const selectedText = useRef<HTMLDivElement>(null);
  const [liveTransform, setLiveTransform] = useState<LiveTransform | null>(
    null,
  );
  const [textBounds, setTextBounds] = useState({ width: 100, height: 30 });
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
    if (!viewport.current) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const s = Math.min(
        (r.width - 48) / project.width,
        (r.height - 40) / project.height,
      );
      setSize({
        width: Math.max(1, project.width * s),
        height: Math.max(1, project.height * s),
      });
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [project.width, project.height]);
  const scale = size.width / project.width;
  const active = project.clips
    .filter((c) => time >= c.start && time < c.start + c.duration)
    .sort(
      (a, b) =>
        project.tracks.findIndex((t) => t.id === a.trackId) -
        project.tracks.findIndex((t) => t.id === b.trackId),
    );
  const selectedVisual = active.find(
    (c) =>
      c.id === selectedId &&
      c.kind !== "audio" &&
      !project.tracks.find((t) => t.id === c.trackId)?.hidden,
  );
  const selectedMedia = project.media.find(
    (m) => m.id === selectedVisual?.mediaId,
  );
  const sourceWidth =
      (selectedMedia?.width || project.width) *
      (selectedVisual?.crop?.width ?? 1),
    sourceHeight =
      (selectedMedia?.height || project.height) *
      (selectedVisual?.crop?.height ?? 1);
  const fit = Math.min(size.width / sourceWidth, size.height / sourceHeight);
  const selectionBox =
    selectedVisual?.kind === "text"
      ? textBounds
      : { width: sourceWidth * fit, height: sourceHeight * fit };
  const total = durationOf(project);
  return (
    <section className="player-panel" aria-label="영상 미리보기">
      <div className="panel-heading">
        <span>플레이어</span>
        {onPreviewMode && (
          <select
            className="preview-mode"
            aria-label="미리보기 모드"
            title="빠른 재생은 즉시 시작합니다. LUT·마스크·오디오 효과·역재생 등은 정밀 재생에서 확인하세요."
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
            title="일부 색상·마스크·LUT·오디오 효과는 정밀 재생에서 확인하세요."
          >
            간편 미리보기
          </span>
        )}
        <span className="heading-meta">
          {project.width} × {project.height}{" "}
          <span className="small-divider">/</span> {project.fps} fps
        </span>
      </div>
      <div className="player-viewport" ref={viewport}>
        <div
          className="composition"
          ref={stage}
          style={{
            width: size.width,
            height: size.height,
            background: project.background || "#000",
          }}
        >
          {project.clips.slice().sort((a, b) => project.tracks.findIndex((track) => track.id === a.trackId) - project.tracks.findIndex((track) => track.id === b.trackId)).map((original) => {
            const sourceMedia = project.media.find((media) => media.id === original.mediaId);
            const clip = sourceMedia?.kind === "audio" && original.kind !== "audio" ? { ...original, kind: "audio" as const } : original;
            const track = project.tracks.find((t) => t.id === clip.trackId);
            const isActive = time >= clip.start && time < clip.start + clip.duration;
            if ((clip.kind === "text" || clip.kind === "image") && (!isActive || track?.hidden)) return null;
            const local = time - clip.start;
            const t = clip.transform;
            const c = clip.color;
            const fade = Math.max(
              0,
              Math.min(
                1,
                clip.fadeIn ? local / clip.fadeIn : 1,
                clip.fadeOut ? (clip.duration - local) / clip.fadeOut : 1,
              ),
            );
            const x =
              liveTransform && selectedId === clip.id
                ? liveTransform.x
                : drag?.id === clip.id
                  ? drag.originX + drag.dx
                  : animatedValue(clip, "x", local, t.x);
            const y =
              liveTransform && selectedId === clip.id
                ? liveTransform.y
                : drag?.id === clip.id
                  ? drag.originY + drag.dy
                  : animatedValue(clip, "y", local, t.y);
            const style = {
              transform: `translate(${x * scale}px,${y * scale}px) scale(${liveTransform && selectedId === clip.id ? liveTransform.scale : animatedValue(clip, "scale", local, t.scale)}) rotate(${animatedValue(clip, "rotation", local, t.rotation)}deg) scale(${t.flipX ? -1 : 1},${t.flipY ? -1 : 1})`,
              opacity: animatedValue(clip, "opacity", local, t.opacity) * fade,
              filter: `brightness(${1 + c.brightness}) contrast(${c.contrast}) saturate(${c.saturation}) ${c.temperature > 0 ? `sepia(${c.temperature * 0.3})` : ""}`,
            };
            if (clip.kind === "audio")
              return (
                <MediaElement
                  key={clip.id}
                  clip={clip}
                  time={time}
                  seekEpoch={seekEpoch}
                  playing={playing && !playbackUrl}
                  muted={muted || !!playbackUrl || !!track?.muted}
                  active={isActive}
                  onError={playbackFailed}
                />
              );
            return (
              <div
                className={`composition-layer  ${clip.kind === "text" ? "text-layer" : ""}`}
                key={clip.id}
                style={{ ...style, display: !isActive || track?.hidden ? "none" : undefined }}
                onPointerDown={(e) => {
                  if (track?.locked) return;
                  e.stopPropagation();
                  onSelect(clip.id);
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({
                    id: clip.id,
                    x: e.clientX,
                    y: e.clientY,
                    originX: t.x,
                    originY: t.y,
                    dx: 0,
                    dy: 0,
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
                      patch: {
                        transform: {
                          ...t,
                          x: Math.round(drag.originX + drag.dx),
                          y: Math.round(drag.originY + drag.dy),
                        },
                      },
                    });
                  setDrag(null);
                }}
              >
                {clip.kind === "text" ? (
                  <div
                    ref={selectedId === clip.id ? selectedText : undefined}
                    style={{
                      fontSize: (clip.text?.fontSize || 64) * scale,
                      color: clip.text?.color || "#fff",
                      fontFamily: clip.text?.fontFamily || "sans-serif",
                      fontWeight: clip.text?.bold ? 700 : 400,
                      textAlign: (clip.text?.align || "center") as "center",
                      background: clip.text?.background || "transparent",
                      whiteSpace: "pre-wrap",
                      padding: "0.15em 0.3em",
                    }}
                  >
                    {clip.text?.content}
                  </div>
                ) : (
                  <MediaElement
                    clip={clip}
                    time={time}
                    seekEpoch={seekEpoch}
                    playing={playing && !playbackUrl}
                    muted={muted || !!playbackUrl || !!track?.muted}
                    active={isActive}
                    onError={playbackFailed}
                  />
                )}
              </div>
            );
          })}
          {playbackUrl && !drag && !liveTransform && !draftActive && (
            <MediaElement
              className="rendered-preview"
              source={playbackUrl}
              clip={{ id: "rendered-preview", kind: "video", trackId: "preview", name: "정밀 미리보기", start: 0, duration: total, sourceIn: 0, speed: 1, reverse: false, volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [] }}
              time={time}
              seekEpoch={seekEpoch}
              playing={playing}
              muted={muted}
              onError={playbackFailed}
              onEnded={() => onPlaying(false)}
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
          {selectedVisual &&
            !playing &&
            !project.tracks.find((t) => t.id === selectedVisual.trackId)
              ?.locked && (
              <SelectionOverlay
                clip={selectedVisual}
                revision={project.revision}
                box={selectionBox}
                ratio={scale}
                rotation={animatedValue(
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
                onPreview={setLiveTransform}
                onCommand={onCommand}
              />
            )}
          {!project.clips.length && (
            <div className="player-empty">
              <span>이야기가 시작되는 곳</span>
              <p>소재를 타임라인에 추가해 주세요.</p>
            </div>
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
          <button
            title={muted ? "소리 켜기" : "소리 끄기"}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <span className="ratio-label">
            {project.width === project.height
              ? "1:1"
              : project.width > project.height
                ? "16:9"
                : "9:16"}
          </span>
          <button
            title="미리보기 전체 화면"
            onClick={() => {
              void stage.current?.requestFullscreen();
            }}
          >
            <Maximize size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}
