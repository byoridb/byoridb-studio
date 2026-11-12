import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { CurvePoint } from "./types";

const identity: CurvePoint[] = [
  [0, 0],
  [1, 1],
];
const bound = (value: number) =>
  Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
export default function CurveEditor({
  points,
  color,
  onCommit,
}: {
  points: CurvePoint[] | undefined;
  color: string;
  onCommit: (points: CurvePoint[]) => void;
}) {
  const initial = points?.length ? points : identity;
  const [draft, setDraft] = useState<CurvePoint[]>(initial);
  const [active, setActive] = useState(0);
  const graph = useRef<HTMLDivElement>(null);
  const latest = useRef(draft);
  const moving = useRef<number | null>(null);
  useEffect(() => {
    const next = points?.length ? points : identity;
    latest.current = next;
    setDraft(next);
    setActive(0);
  }, [points]);
  const update = (next: CurvePoint[]) => {
    latest.current = next;
    setDraft(next);
  };
  const movePoint = (index: number, x: number, y: number) => {
    const current = latest.current;
    const next: CurvePoint[] = current.map((point, i) =>
      i !== index
        ? point
        : [
            index === 0
              ? 0
              : index === current.length - 1
                ? 1
                : Math.max(
                    current[index - 1][0] + 0.001,
                    Math.min(current[index + 1][0] - 0.001, bound(x)),
                  ),
            bound(y),
          ],
    );
    update(next);
  };
  const position = (event: React.PointerEvent) => {
    const rect = graph.current!.getBoundingClientRect();
    return [
      bound((event.clientX - rect.left) / rect.width),
      bound(1 - (event.clientY - rect.top) / rect.height),
    ] as CurvePoint;
  };
  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = (event.target as HTMLElement).closest("[data-curve-point]");
    let index = target ? Number(target.getAttribute("data-curve-point")) : -1;
    if (index < 0) {
      if (latest.current.length >= 16) return;
      const [x, y] = position(event);
      if (
        x === 0 ||
        x === 1 ||
        latest.current.some((point) => Math.abs(point[0] - x) < 0.005)
      )
        return;
      const next = [...latest.current, [x, y] as CurvePoint].sort(
        (a, b) => a[0] - b[0],
      );
      index = next.findIndex((point) => point[0] === x);
      update(next);
    }
    moving.current = index;
    setActive(index);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const remove = () => {
    if (active === 0 || active === latest.current.length - 1) return;
    const next = latest.current.filter((_, index) => index !== active);
    update(next);
    setActive(Math.max(0, active - 1));
    onCommit(next);
  };
  const add = () => {
    const current = latest.current;
    if (current.length >= 16) return;
    let index = 0;
    for (let i = 1; i < current.length - 1; i++)
      if (
        current[i + 1][0] - current[i][0] >
        current[index + 1][0] - current[index][0]
      )
        index = i;
    const point: CurvePoint = [
      (current[index][0] + current[index + 1][0]) / 2,
      (current[index][1] + current[index + 1][1]) / 2,
    ];
    const next = [
      ...current.slice(0, index + 1),
      point,
      ...current.slice(index + 1),
    ];
    update(next);
    setActive(index + 1);
    onCommit(next);
  };
  return (
    <div className="curve-editor">
      <div
        ref={graph}
        className="curve-graph"
        onPointerDown={begin}
        onPointerMove={(event) => {
          if (moving.current !== null) {
            event.stopPropagation();
            const [x, y] = position(event);
            movePoint(moving.current, x, y);
          }
        }}
        onPointerUp={() => {
          if (moving.current !== null) {
            moving.current = null;
            onCommit(latest.current);
          }
        }}
        onPointerCancel={() => {
          moving.current = null;
          update(initial);
        }}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label="톤 곡선 제어점"
        >
          <path className="curve-identity" d="M0 100L100 0" />
          <polyline
            points={draft
              .map(([x, y]) => `${x * 100},${100 - y * 100}`)
              .join(" ")}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {draft.map(([x, y], index) => (
          <button
            key={index}
            type="button"
            data-curve-point={index}
            className={`curve-point ${active === index ? "active" : ""}`}
            style={{
              left: `${x * 100}%`,
              top: `${(1 - y) * 100}%`,
              borderColor: color,
            }}
            aria-label={`곡선 점 ${index + 1}, 입력 ${Math.round(x * 255)}, 출력 ${Math.round(y * 255)}`}
            onFocus={() => setActive(index)}
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                event.stopPropagation();
                const step = event.shiftKey ? 0.05 : 0.01;
                movePoint(
                  index,
                  x +
                    (event.key === "ArrowRight"
                      ? step
                      : event.key === "ArrowLeft"
                        ? -step
                        : 0),
                  y +
                    (event.key === "ArrowUp"
                      ? step
                      : event.key === "ArrowDown"
                        ? -step
                        : 0),
                );
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                event.stopPropagation();
                remove();
              }
            }}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow")) {
                event.stopPropagation();
                onCommit(latest.current);
              }
            }}
          />
        ))}
      </div>
      <div className="curve-actions">
        <span>
          입력 {Math.round((draft[active]?.[0] || 0) * 255)} <span>→</span> 출력{" "}
          {Math.round((draft[active]?.[1] || 0) * 255)}
        </span>
        <button
          aria-label="곡선 점 추가"
          title="제어점 추가"
          disabled={draft.length >= 16}
          onClick={add}
        >
          <Plus size={13} />
        </button>
        <button
          aria-label="선택한 곡선 점 삭제"
          title="제어점 삭제"
          disabled={active === 0 || active === draft.length - 1}
          onClick={remove}
        >
          <Minus size={13} />
        </button>
      </div>
      <p className="panel-help">
        그래프를 클릭해 점을 추가하세요. 점을 드래그하거나 방향키로 조절할 수
        있습니다.
      </p>
    </div>
  );
}
