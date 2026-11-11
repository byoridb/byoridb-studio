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
