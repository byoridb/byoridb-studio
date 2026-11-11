import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SelectionOverlay from "./SelectionOverlay";
import type { Clip } from "./types";

const clip: Clip = {
  id: "clip",
  trackId: "video",
  name: "image",
  kind: "image",
  start: 0,
  duration: 5,
  sourceIn: 0,
  speed: 1,
  reverse: false,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  keyframes: [],
};
it("resizes the selected clip with a revision-guarded command", () => {
  const command = vi.fn().mockResolvedValue({});
  render(
    <SelectionOverlay
      clip={clip}
      revision={12}
      box={{ width: 400, height: 225 }}
      ratio={0.5}
      transform={{ x: 0, y: 0, scale: 1 }}
      rotation={0}
      onPreview={vi.fn()}
      onCommand={command}
    />,
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: "선택 클립 크기 조절 se" }),
    { key: "ArrowUp" },
  );
  expect(command).toHaveBeenCalledWith("edit.update", {
    id: "clip",
    expectedRevision: 12,
    patch: { transform: { ...clip.transform, scale: 1.01 } },
  });
});
it("moves in project pixels and preserves unrelated transform properties", () => {
  const command = vi.fn().mockResolvedValue({});
  render(
    <SelectionOverlay
      clip={clip}
      revision={12}
      box={{ width: 400, height: 225 }}
      ratio={0.5}
      transform={{ x: 0, y: 0, scale: 1 }}
      rotation={0}
      onPreview={vi.fn()}
      onCommand={command}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "선택 클립 이동" }), {
    key: "ArrowRight",
    shiftKey: true,
  });
  expect(command).toHaveBeenCalledWith("edit.update", {
    id: "clip",
    expectedRevision: 12,
    patch: { transform: { ...clip.transform, x: 10, y: 0 } },
  });
});
it("edits the keyframe at the playhead when the moved property is animated", () => {
  const command = vi.fn().mockResolvedValue({});
  const animated: Clip = { ...clip, start: 1, keyframes: [
    { property: "x", time: 0, value: 0 },
    { property: "x", time: 2, value: 200 },
  ] };
  render(
    <SelectionOverlay
      clip={animated}
      revision={12}
      box={{ width: 400, height: 225 }}
      ratio={0.5}
      transform={{ x: 200, y: 0, scale: 1 }}
      rotation={0}
      time={3}
      fps={30}
      onPreview={vi.fn()}
      onCommand={command}
    />,
  );
  const handle = screen.getByRole("button", { name: "선택 클립 이동" });
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { clientX: 150, clientY: 110 });
  fireEvent.pointerUp(handle);
  expect(command).toHaveBeenCalledWith("edit.update", {
    id: "clip",
    expectedRevision: 12,
    patch: {
      transform: { ...clip.transform, y: 20 },
      keyframes: [
        { property: "x", time: 0, value: 0 },
        { property: "x", time: 2, value: 300 },
      ],
    },
  });
});
it("rotates with the handle, sticking to right angles, and from the keyboard", () => {
  const command = vi.fn().mockResolvedValue({});
  const preview = vi.fn();
  const { container } = render(
    <SelectionOverlay clip={clip} revision={3} box={{ width: 200, height: 100 }} ratio={0.5}
      transform={{ x: 0, y: 0, scale: 1 }} rotation={0} onPreview={preview} onCommand={command} />,
  );
  const overlay = container.querySelector<HTMLElement>(".selection-overlay")!;
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  const handle = screen.getByRole("button", { name: "선택 클립 회전" });
  handle.setPointerCapture = vi.fn();
  // The handle sits above the centre (100, 50); dragging it to the right of the centre is a quarter turn.
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 0 });
  fireEvent.pointerMove(handle, { clientX: 150, clientY: 51 });
  expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ rotation: 90 }));
  fireEvent.pointerUp(handle);
  expect(command).toHaveBeenLastCalledWith("edit.update", { id: "clip", expectedRevision: 3, patch: { transform: { ...clip.transform, rotation: 90 } } });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 0 });
  fireEvent.pointerMove(handle, { clientX: 120, clientY: 0, altKey: true });
  fireEvent.pointerUp(handle);
  const free = command.mock.calls[command.mock.calls.length - 1][1].patch.transform.rotation;
  expect(free).toBeCloseTo(21.8, 1);
  fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
  expect(command).toHaveBeenLastCalledWith("edit.update", { id: "clip", expectedRevision: 3, patch: { transform: { ...clip.transform, rotation: 15 } } });
});
it("snaps a moved clip to the frame centre and edges and reports the guide", () => {
  const command = vi.fn().mockResolvedValue({});
  const preview = vi.fn();
  // A 400×200 project-pixel box (200×100 on screen at ratio 0.5) in a 1920×1080 frame.
  render(
    <SelectionOverlay clip={clip} revision={3} box={{ width: 200, height: 100 }} ratio={0.5} stage={{ width: 1920, height: 1080 }}
      transform={{ x: 100, y: 300, scale: 1 }} rotation={0} onPreview={preview} onCommand={command} />,
  );
  const handle = screen.getByRole("button", { name: "선택 클립 이동" });
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { clientX: 500, clientY: 500 });
  // 100 → 4 project px from the centre: within reach, so it lands on 0.
  fireEvent.pointerMove(handle, { clientX: 452, clientY: 500 });
  expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 300, guides: { x: 0 } }));
  // The left edge reaches the frame edge: x = -960 + 200.
  fireEvent.pointerMove(handle, { clientX: 500 - 431, clientY: 500 });
  expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ x: -760, guides: { x: -960 } }));
  // ⌥ moves freely.
  fireEvent.pointerMove(handle, { clientX: 452, clientY: 500, altKey: true });
  expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ x: 4, guides: undefined }));
  fireEvent.pointerMove(handle, { clientX: 452, clientY: 500 });
  fireEvent.pointerUp(handle);
  expect(command).toHaveBeenCalledWith("edit.update", { id: "clip", expectedRevision: 3, patch: { transform: { ...clip.transform, x: 0, y: 300 } } });
});
