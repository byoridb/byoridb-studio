import { useRef } from "react";
import type { Clip, Command } from "./types";
import { canvasTransformPatch } from "./clipEditing";
import "./selection-overlay.css";

export type LiveTransform = {
  x: number;
  y: number;
  scale: number;
  rotation?: number;
  /** Active snap lines in project pixels from the frame centre. */
  guides?: { x?: number; y?: number };
};
type Mode = "move" | "scale" | "rotate";
const SNAP_PIXELS = 6;
const normalizeAngle = (angle: number) => ((((angle + 180) % 360) + 360) % 360) - 180;
export default function SelectionOverlay({
  clip,
  revision,
  box,
  ratio,
  transform,
  rotation,
  stage,
  time = clip.start,
  fps = 30,
  onPreview,
  onCommand,
}: {
  clip: Clip;
  revision: number;
  box: { width: number; height: number };
  ratio: number;
  transform: LiveTransform;
  rotation: number;
  /** Project frame size: enables centre and edge snapping while moving. */
  stage?: { width: number; height: number };
  /** Project time and frame rate: an animated property is edited as a keyframe here. */
  time?: number;
  fps?: number;
  onPreview: (value: LiveTransform | null) => void;
  onCommand: Command;
}) {
  const gesture = useRef<{
    mode: Mode;
    x: number;
    y: number;
    cx: number;
    cy: number;
    distance: number;
    angle: number;
    origin: LiveTransform;
    next: LiveTransform;
    revision: number;
  } | null>(null);
  const begin = (
    event: React.PointerEvent<HTMLElement>,
    mode: Mode,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget
      .closest(".selection-overlay")!
      .getBoundingClientRect();
    const cx = bounds.left + bounds.width / 2,
      cy = bounds.top + bounds.height / 2;
    gesture.current = {
      mode,
      x: event.clientX,
      y: event.clientY,
      cx,
      cy,
      distance: Math.max(1, Math.hypot(event.clientX - cx, event.clientY - cy)),
      angle: Math.atan2(event.clientY - cy, event.clientX - cx),
      origin: { ...transform, rotation, guides: undefined },
      next: { ...transform, rotation, guides: undefined },
      revision,
    };
    onPreview(transform);
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === "move") {
      let x = g.origin.x + (event.clientX - g.x) / ratio;
      let y = g.origin.y + (event.clientY - g.y) / ratio;
      const guides: { x?: number; y?: number } = {};
      // Snap the centre, or an edge of an unrotated box, to the frame centre and edges. ⌥ moves freely.
      if (stage && !event.altKey) {
        const reach = SNAP_PIXELS / ratio;
        const upright = Math.abs(normalizeAngle(rotation)) < 0.5;
        const snap = (value: number, half: number, limit: number) => {
          const targets: [number, number][] = [[0, 0]];
          if (upright)
            targets.push([-limit + half, -limit], [limit - half, limit]);
          let best: [number, number] | null = null;
          for (const target of targets)
            if (Math.abs(target[0] - value) <= reach && (!best || Math.abs(target[0] - value) < Math.abs(best[0] - value)))
              best = target;
          return best;
        };
        const sx = snap(x, (box.width / ratio) * g.origin.scale / 2, stage.width / 2);
        const sy = snap(y, (box.height / ratio) * g.origin.scale / 2, stage.height / 2);
        if (sx) { x = sx[0]; guides.x = sx[1]; }
        if (sy) { y = sy[0]; guides.y = sy[1]; }
      }
      g.next = { ...g.origin, x, y, guides: guides.x !== undefined || guides.y !== undefined ? guides : undefined };
    } else if (g.mode === "rotate") {
      const turned = ((Math.atan2(event.clientY - g.cy, event.clientX - g.cx) - g.angle) * 180) / Math.PI;
      let angle = normalizeAngle((g.origin.rotation ?? 0) + turned);
      // ⇧ steps by 15°; otherwise right angles and diagonals are sticky unless ⌥ is held.
      if (event.shiftKey) angle = Math.round(angle / 15) * 15;
      else if (!event.altKey && Math.abs(angle - Math.round(angle / 45) * 45) < 3) angle = Math.round(angle / 45) * 45;
      g.next = { ...g.origin, rotation: Math.round(angle * 10) / 10 };
    } else
      g.next = {
        ...g.origin,
        scale: Math.max(
          0.05,
          Math.min(
            10,
            (g.origin.scale *
              Math.hypot(event.clientX - g.cx, event.clientY - g.cy)) /
              g.distance,
          ),
        ),
      };
    onPreview(g.next);
  };
  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    onPreview(null);
    if (g && JSON.stringify({ ...g.next, guides: 0 }) !== JSON.stringify({ ...g.origin, guides: 0 }))
      void onCommand("edit.update", {
        id: clip.id,
        expectedRevision: g.revision,
        patch: canvasTransformPatch(
          clip,
          g.mode === "move"
            ? { x: g.next.x, y: g.next.y }
            : g.mode === "rotate"
              ? { rotation: g.next.rotation ?? 0 }
              : { scale: g.next.scale },
          time,
          fps,
        ),
      });
  };
  return (
    <div
      className="selection-overlay"
      style={{
        width: Math.max(2, box.width - 2),
        height: Math.max(2, box.height - 2),
        transform: `translate(-50%,-50%) translate(${transform.x * ratio}px,${transform.y * ratio}px) rotate(${rotation}deg) scale(${transform.scale})`,
      }}
    >
      <button
        className="selection-move"
        title="선택 클립 이동"
        aria-label="선택 클립 이동"
        onPointerDown={(e) => begin(e, "move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          gesture.current = null;
          onPreview(null);
        }}
        onKeyDown={(e) => {
          const delta = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          }[e.key];
          if (!delta) return;
          e.preventDefault();
          e.stopPropagation();
          void onCommand("edit.update", {
            id: clip.id,
            expectedRevision: revision,
            patch: canvasTransformPatch(
              clip,
              {
                x: transform.x + delta[0] * (e.shiftKey ? 10 : 1),
                y: transform.y + delta[1] * (e.shiftKey ? 10 : 1),
              },
              time,
              fps,
            ),
          });
        }}
      />
      <button
        className="selection-rotate"
        aria-label="선택 클립 회전"
        title="드래그로 회전 · ⇧ 15° 단위 · ← → 1°"
        onPointerDown={(e) => begin(e, "rotate")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          gesture.current = null;
          onPreview(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          const step = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 15 : 1);
          void onCommand("edit.update", {
            id: clip.id,
            expectedRevision: revision,
            patch: canvasTransformPatch(clip, { rotation: normalizeAngle(rotation + step) }, time, fps),
          });
        }}
      />
      {["nw", "ne", "sw", "se"].map((corner) => (
        <button
          key={corner}
          className={`selection-handle ${corner}`}
          aria-label={`선택 클립 크기 조절 ${corner}`}
          title="드래그로 크기 조절 · 방향키 ±1%"
          onPointerDown={(e) => begin(e, "scale")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={() => {
            gesture.current = null;
            onPreview(null);
          }}
          onKeyDown={(e) => {
            if (
              !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
                e.key,
              )
            )
              return;
            e.preventDefault();
            e.stopPropagation();
            const delta = ["ArrowUp", "ArrowRight"].includes(e.key)
              ? 0.01
              : -0.01;
            void onCommand("edit.update", {
              id: clip.id,
              expectedRevision: revision,
              patch: canvasTransformPatch(
                clip,
                { scale: Math.max(0.05, Math.min(10, transform.scale + delta)) },
                time,
                fps,
              ),
            });
          }}
        />
      ))}
    </div>
  );
}
