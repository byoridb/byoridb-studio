import { describe, expect, it } from "vitest";
import { withPreviewDraft } from "./previewDraft";
import type { Project } from "./types";

const project: Project = {
  id: "project",
  name: "Draft regression",
  revision: 4,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#111214",
  media: [],
  tracks: [],
  clips: [
    {
      id: "clip",
      name: "Image",
      trackId: "track",
      kind: "image",
      start: 0,
      duration: 5,
      sourceIn: 0,
      speed: 1,
      reverse: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      transform: { x: 12, y: 24, scale: 1, rotation: 0, opacity: 1 },
      color: {
        brightness: 0,
        contrast: 1.2,
        saturation: 0.8,
        temperature: 0.1,
        hsl: { red: { hue: 10, saturation: 0.2, lightness: 0.3 } },
      },
      keyframes: [
        { property: "scale", time: 0, value: 1 },
        { property: "scale", time: 2, value: 2 },
      ],
    },
  ],
  markers: [],
  notes: [],
  updatedAt: 1,
  concept: { audience: "", message: "", appeal: "", direction: "" },
};

describe("preview draft merge", () => {
  it("merges imported partial presets recursively without changing the authoritative project", () => {
    const before = structuredClone(project);
    const result = withPreviewDraft(project, {
      clipId: "clip",
      patch: {
        color: { brightness: 0.2, hsl: { red: { hue: 30 } } },
        transform: { x: 50 },
      },
    });
    expect(result.clips[0].color).toEqual({
      ...project.clips[0].color,
      brightness: 0.2,
      hsl: { red: { hue: 30, saturation: 0.2, lightness: 0.3 } },
    });
    expect(result.clips[0].transform).toEqual({
      ...project.clips[0].transform,
      x: 50,
    });
    expect(project).toEqual(before);
    expect(result.revision).toBe(project.revision);
  });

  it("replaces arrays instead of merging indexes", () => {
    const keyframes = [{ property: "opacity", time: 1, value: 0.5 }];
    const result = withPreviewDraft(project, {
      clipId: "clip",
      patch: { keyframes },
    });
    expect(result.clips[0].keyframes).toEqual(keyframes);
    expect(result.clips[0].keyframes).not.toBe(keyframes);
    expect(project.clips[0].keyframes).toHaveLength(2);
  });

  it("drops prototype-related keys recursively from imported data", () => {
    const patch = JSON.parse(
      '{"__proto__":{"polluted":true},"color":{"brightness":0.2,"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}},"keyframes":[{"property":"scale","time":0,"value":1,"__proto__":{"polluted":true}}]}',
    );
    const result = withPreviewDraft(project, { clipId: "clip", patch });
    expect(result.clips[0].color.brightness).toBe(0.2);
    expect(Object.prototype.hasOwnProperty.call(result.clips[0], "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.clips[0].color, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.clips[0].color, "prototype")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.clips[0].keyframes[0], "__proto__")).toBe(
      false,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
