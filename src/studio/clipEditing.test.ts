import { describe, expect, it } from "vitest";
import { canvasTransformPatch, clipEditCommands, trimClipPreview, waveformBars, waveformRange } from "./clipEditing";
import type { Clip, Project } from "./types";

const clip: Clip = { id: "clip", mediaId: "media", trackId: "video", name: "Clip", kind: "video", start: 3, duration: 4, sourceIn: 2, speed: 2, reverse: false, volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [] };
const project: Project = { id: "p", name: "P", revision: 1, fps: 30, width: 1920, height: 1080, background: "", clips: [clip], tracks: [{ id: "video", name: "Video", kind: "video", muted: false, hidden: false, locked: false }], media: [{ id: "media", name: "Source", path: "/source.mp4", kind: "video", duration: 12, width: 1920, height: 1080, hasAudio: true }], markers: [], notes: [], concept: { audience: "", message: "", appeal: "", direction: "" }, updatedAt: 1 };

describe("clip boundary editing", () => {
  it("cuts only selected clips spanning the frame-aligned playhead", () => {
    const later = { ...clip, id: "later", start: 8 };
    const p = { ...project, clips: [clip, later] };
    expect(clipEditCommands(p, [clip.id, later.id], 5.009, "split")).toEqual([{ method: "edit.split", params: { id: "clip", time: 5 } }]);
    expect(clipEditCommands(p, [clip.id], 5, "trim-start")).toEqual([{ method: "edit.trim", params: { id: "clip", start: 5 } }]);
    expect(clipEditCommands(p, [clip.id], 5, "trim-end")).toEqual([{ method: "edit.trim", params: { id: "clip", end: 5 } }]);
  });
  it("rejects locked selections and cuts leaving less than a frame", () => {
    const locked = { ...project, tracks: project.tracks.map((track) => ({ ...track, locked: true })) };
    expect(clipEditCommands(locked, [clip.id], 5, "split")).toEqual([]);
    expect(trimClipPreview(locked, clip, "start", 4)).toBeNull();
    expect(clipEditCommands(project, [clip.id], 3.001, "trim-start")).toEqual([]);
    expect(clipEditCommands(project, [clip.id], 7, "split")).toEqual([]);
    expect(clipEditCommands(project, ["missing"], 5, "split")).toEqual([]);
    expect(trimClipPreview(project, clip, "end", NaN)).toBeNull();
  });
  it("trims and restores forward source boundaries at the clip speed", () => {
    expect(trimClipPreview(project, clip, "start", 5)).toEqual({ start: 5, duration: 2, sourceIn: 6 });
    expect(trimClipPreview(project, clip, "end", 5)).toEqual({ start: 3, duration: 2, sourceIn: 2 });
    expect(trimClipPreview(project, clip, "start", -10)).toEqual({ start: 2, duration: 5, sourceIn: 0 });
    expect(trimClipPreview(project, clip, "end", 100)).toEqual({ start: 3, duration: 5, sourceIn: 2 });
  });
  it("uses opposite source edges for reverse playback", () => {
    const reverse = { ...clip, reverse: true };
    const p = { ...project, clips: [reverse] };
    expect(trimClipPreview(p, reverse, "start", 5)).toEqual({ start: 5, duration: 2, sourceIn: 2 });
    expect(trimClipPreview(p, reverse, "end", 5)).toEqual({ start: 3, duration: 2, sourceIn: 6 });
    expect(trimClipPreview(p, reverse, "start", -10)).toEqual({ start: 2, duration: 5, sourceIn: 2 });
    expect(trimClipPreview(p, reverse, "end", 100)).toEqual({ start: 3, duration: 5, sourceIn: 0 });
  });
  it("preserves exact snap points and one-frame nudges from off-grid boundaries", () => {
    const snapped = trimClipPreview(project, clip, "end", 5.01)!;
    expect(snapped.start! + snapped.duration!).toBeCloseTo(5.01, 10);
    const shifted = { ...clip, start: 3.01 };
    const p = { ...project, clips: [shifted] };
    const nudged = trimClipPreview(p, shifted, "start", shifted.start + 1 / p.fps)!;
    expect(nudged.start! - shifted.start).toBeCloseTo(1 / p.fps, 10);
    expect(nudged.sourceIn! - shifted.sourceIn).toBeCloseTo(shifted.speed / p.fps, 10);
  });
  it("extends still images and captions without media-source limits", () => {
    for (const kind of ["text", "image"] as const) {
      const still = { ...clip, kind, sourceIn: 0, speed: 1 };
      const p = { ...project, clips: [still] };
      expect(trimClipPreview(p, still, "start", 0)).toEqual({ start: 0, duration: 7, sourceIn: 0 });
      expect(trimClipPreview(p, still, "end", 20)).toEqual({ start: 3, duration: 17, sourceIn: 0 });
    }
    expect(trimClipPreview(project, clip, "end", 7)).toBeNull();
    expect(trimClipPreview(project, clip, "end", 0)?.duration).toBeCloseTo(1 / 30);
  });
});

describe("canvas edits on animated clips", () => {
  it("writes static properties to the transform and leaves keyframes alone", () => {
    expect(canvasTransformPatch(clip, { x: 40, y: -10 }, 5, 30)).toEqual({ transform: { ...clip.transform, x: 40, y: -10 } });
  });
  it("updates the keyframe at the playhead, or adds one, for an animated property", () => {
    const animated: Clip = { ...clip, keyframes: [
      { property: "x", time: 0, value: 0 },
      { property: "transform.x", time: 2, value: 100 },
      { property: "opacity", time: 2, value: 0.5 },
    ] };
    // Project time 5 is local time 2: the existing x keyframe is replaced, y stays static.
    expect(canvasTransformPatch(animated, { x: 250, y: 30 }, 5.01, 30)).toEqual({
      transform: { ...clip.transform, y: 30 },
      keyframes: [
        { property: "x", time: 0, value: 0 },
        { property: "opacity", time: 2, value: 0.5 },
        { property: "x", time: expect.closeTo(2.01, 10), value: 250 },
      ],
    });
    const added = canvasTransformPatch(animated, { x: 50 }, 4, 30).keyframes!;
    expect(added.filter((key) => key.property.endsWith("x")).map((key) => [key.time, key.value])).toEqual([[0, 0], [1, 50], [2, 100]]);
    expect(canvasTransformPatch(animated, { scale: 2 }, 4, 30)).toEqual({ transform: { ...clip.transform, scale: 2 } });
  });
});
describe("clip waveform range", () => {
  it("maps sourceIn, duration and speed onto the stored peaks", () => {
    expect(waveformRange({ ...clip, sourceIn: 0, duration: 6, speed: 1 }, 12, 120)).toEqual([0, 60]);
    expect(waveformRange(clip, 12, 120)).toEqual([20, 100]);
    expect(waveformRange({ ...clip, sourceIn: 11, duration: 4, speed: 1 }, 12, 120)).toEqual([110, 120]);
    // Peaks describe the whole source, however long it is.
    expect(waveformRange({ ...clip, sourceIn: 300, duration: 150, speed: 1 }, 3600, 1024)).toEqual([85, 128]);
    expect(waveformRange({ ...clip, sourceIn: 3590, duration: 10, speed: 1 }, 3600, 1024)).toEqual([1021, 1024]);
    expect(waveformBars([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3)).toEqual([0.9, 0.3, 0.5]);
    expect(waveformBars([0.1, 0.2], 3)).toEqual([0.1, 0.2]);
  });
});
