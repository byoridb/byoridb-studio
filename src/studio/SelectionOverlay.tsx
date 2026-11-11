import { useRef } from "react";
import type { Clip, Command } from "./types";
import "./selection-overlay.css";

export type LiveTransform = { x: number; y: number; scale: number };
export default function SelectionOverlay({
  clip,
  revision,
  box,
  ratio,
  transform,
  rotation,
  onPreview,
  onCommand,
}: {
  clip: Clip;
  revision: number;
  box: { width: number; height: number };
  ratio: number;
  transform: LiveTransform;
  rotation: number;
  onPreview: (value: LiveTransform | null) => void;
  onCommand: Command;
}) {
  const gesture = useRef<{
    mode: "move" | "scale";
    x: number;
    y: number;
    cx: number;
    cy: number;
    distance: number;
    origin: LiveTransform;
    next: LiveTransform;
    revision: number;
  } | null>(null);
  const begin = (
    event: React.PointerEvent<HTMLElement>,
    mode: "move" | "scale",
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
      origin: transform,
      next: transform,
      revision,
    };
    onPreview(transform);
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    g.next =
      g.mode === "move"
        ? {
            ...g.origin,
            x: g.origin.x + (event.clientX - g.x) / ratio,
            y: g.origin.y + (event.clientY - g.y) / ratio,
          }
        : {
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
    if (g && JSON.stringify(g.next) !== JSON.stringify(g.origin))
      void onCommand("edit.update", {
        id: clip.id,
        expectedRevision: g.revision,
        patch: { transform: { ...clip.transform, ...g.next } },
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
            patch: {
              transform: {
                ...clip.transform,
                x: transform.x + delta[0] * (e.shiftKey ? 10 : 1),
                y: transform.y + delta[1] * (e.shiftKey ? 10 : 1),
              },
            },
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
              patch: {
                transform: {
                  ...clip.transform,
                  scale: Math.max(0.05, Math.min(10, transform.scale + delta)),
                },
              },
            });
          }}
        />
      ))}
    </div>
  );
}
