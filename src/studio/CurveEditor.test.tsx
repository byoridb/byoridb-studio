import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CurveEditor from "./CurveEditor";

function graph() {
  const element = document.querySelector<HTMLElement>(".curve-graph")!;
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return element;
}

describe("CurveEditor", () => {
  it("adds a point by pointer, previews the drag and commits once on release", () => {
    const onCommit = vi.fn();
    render(<CurveEditor points={undefined} color="#fff" onCommit={onCommit} />);
    const area = graph();
    fireEvent.pointerDown(area, { button: 0, clientX: 100, clientY: 50 });
    expect(screen.getAllByRole("button", { name: /^곡선 점 \d/ })).toHaveLength(3);
    fireEvent.pointerMove(area, { clientX: 50, clientY: 20 });
    fireEvent.pointerMove(area, { clientX: 60, clientY: 25 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "곡선 점 2, 입력 77, 출력 191" }),
    ).toBeInTheDocument();
    fireEvent.pointerUp(area);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith([
      [0, 0],
      [0.3, 0.75],
      [1, 1],
    ]);
  });

  it("keeps end points on the edges and interior points between neighbours", () => {
    const onCommit = vi.fn();
    render(
      <CurveEditor
        points={[
          [0, 0],
          [0.5, 0.5],
          [1, 1],
        ]}
        color="#fff"
        onCommit={onCommit}
      />,
    );
    const area = graph();
    const points = screen.getAllByRole("button", { name: /^곡선 점 \d/ });
    fireEvent.pointerDown(points[0], { button: 0, clientX: 0, clientY: 100 });
    fireEvent.pointerMove(area, { clientX: 120, clientY: 60 });
    fireEvent.pointerUp(area);
    fireEvent.pointerDown(points[1], { button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(area, { clientX: 400, clientY: -40 });
    fireEvent.pointerUp(area);
    expect(onCommit).toHaveBeenLastCalledWith([
      [0, 0.4],
      [0.999, 1],
      [1, 1],
    ]);
  });

  it("restores the committed curve when the drag is cancelled", () => {
    const onCommit = vi.fn();
    render(<CurveEditor points={undefined} color="#fff" onCommit={onCommit} />);
    const area = graph();
    fireEvent.pointerDown(area, { button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerCancel(area);
    expect(screen.getAllByRole("button", { name: /^곡선 점 \d/ })).toHaveLength(2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("removes the selected interior point and never an end point", () => {
    const onCommit = vi.fn();
    render(
      <CurveEditor
        points={[
          [0, 0],
          [0.5, 0.6],
          [1, 1],
        ]}
        color="#fff"
        onCommit={onCommit}
      />,
    );
    const remove = screen.getByRole("button", { name: "선택한 곡선 점 삭제" });
    expect(remove).toBeDisabled();
    fireEvent.focus(screen.getAllByRole("button", { name: /^곡선 점 \d/ })[1]);
    fireEvent.click(remove);
    expect(onCommit).toHaveBeenCalledWith([
      [0, 0],
      [1, 1],
    ]);
    expect(remove).toBeDisabled();
  });

  it("follows externally changed points", () => {
    const { rerender } = render(
      <CurveEditor points={undefined} color="#fff" onCommit={vi.fn()} />,
    );
    rerender(
      <CurveEditor
        points={[
          [0, 0.1],
          [0.4, 0.5],
          [1, 0.9],
        ]}
        color="#fff"
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^곡선 점 \d/ })).toHaveLength(3);
  });
});
