// @ts-expect-error The app has no Node typings; the test runner provides the module.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activeAnimationPreset,
  animationPresetKeyframes,
  animationPresets,
  incomingTransitionCommands,
  joinTransitionCommands,
  overlapWithPrevious,
  separateTransitionCommands,
  stickers,
  textPresets,
  transitionPatch,
  valueAt,
  withKeyframe,
  withKeyframeChange,
} from "./clipPresets";
import type { Clip, Project } from "./types";

const clip: Clip = {
  id: "b",
  trackId: "v",
  name: "b",
  kind: "video",
  start: 4,
  duration: 4,
  sourceIn: 0,
  speed: 1,
  reverse: false,
  volume: 0.8,
  fadeIn: 0,
  fadeOut: 0,
  transform: { x: 10, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  keyframes: [],
};
const project = (clips: Clip[]) =>
  ({ fps: 30, width: 1920, height: 1080, clips }) as Project;

describe("transitions", () => {
  it("keeps the two edges inside the clip", () => {
    expect(transitionPatch({ ...clip, fadeOut: 3 }, "in", "zoom", 2)).toEqual({
      transitionIn: { type: "zoom", duration: 1 },
      fadeIn: 1,
    });
    expect(transitionPatch(clip, "out", null, 2)).toEqual({
      transitionOut: null,
      fadeOut: 0,
    });
  });

  it("joins only touching clips and leaves other tracks alone", () => {
    const a = { ...clip, id: "a", start: 0 };
    const other = { ...clip, id: "o", trackId: "v2", start: 6 };
    const after = { ...clip, id: "c", start: 8 };
    const commands = joinTransitionCommands(project([a, clip, other, after]), clip, "wipeLeft", 1);
    expect(commands.map((c) => [c.params.id, (c.params.patch as Clip).start])).toEqual([
      ["b", 3],
      ["c", 7],
    ]);
    const gap = { ...clip, start: 5 };
    expect(joinTransitionCommands(project([a, gap]), gap, "fade", 1)).toEqual([]);
    expect(joinTransitionCommands(project([clip]), clip, "fade", 1)).toEqual([]);
  });

  it("limits the overlap to half of the shorter clip and undoes it exactly", () => {
    const a = { ...clip, id: "a", start: 3, duration: 1 };
    const [first] = joinTransitionCommands(project([a, clip]), clip, "dissolve", 3);
    expect(first.params.patch).toMatchObject({ start: 3.5, fadeIn: 0.5 });
    const joined = { ...clip, start: 3.5, fadeIn: 0.5 };
    const after = { ...clip, id: "c", start: 7.5 };
    const value = project([a, joined, after]);
    expect(overlapWithPrevious(value, joined)).toBeCloseTo(0.5);
    // The later clip moves first so the track never collides while moving back.
    expect(
      separateTransitionCommands(value, joined).map((c) => [
        c.params.id,
        (c.params.patch as Clip).start,
      ]),
    ).toEqual([
      ["b", 4],
      ["c", 8],
    ]);
  });

  it("uses a fade for audio clips whatever type was asked for", () => {
    const a = { ...clip, id: "a", start: 0, kind: "audio" as const };
    const audio = { ...clip, kind: "audio" as const };
    const [first] = joinTransitionCommands(project([a, audio]), audio, "dissolve", 0.5);
    expect(first.params.patch).toEqual({
      start: 3.5,
      transitionIn: { type: "fade", duration: 0.5 },
      fadeIn: 0.5,
    });
  });

  it("keeps the overlap equal to the transition when a joined clip's length or type changes", () => {
    const a = { ...clip, id: "a", start: 0 };
    const joined = {
      ...clip,
      start: 3.5,
      fadeIn: 0.5,
      transitionIn: { type: "dissolve" as const, duration: 0.5 },
    };
    const after = { ...clip, id: "c", start: 7.5 };
    const value = project([a, joined, after]);
    expect(
      incomingTransitionCommands(value, joined, { type: "wipeLeft", duration: 2 }),
    ).toEqual([
      {
        method: "edit.update",
        params: {
          id: "b",
          patch: { start: 2, transitionIn: { type: "wipeLeft", duration: 2 }, fadeIn: 2 },
        },
      },
      { method: "edit.update", params: { id: "c", patch: { start: 6 } } },
    ]);
    // A type change alone moves nothing.
    expect(
      incomingTransitionCommands(value, joined, { type: "zoom", duration: 0.5 }),
    ).toEqual([
      {
        method: "edit.update",
        params: { id: "b", patch: { transitionIn: { type: "zoom", duration: 0.5 }, fadeIn: 0.5 } },
      },
    ]);
    // The section reset also clears the out transition.
    expect(
      separateTransitionCommands(value, joined, { transitionOut: null, fadeOut: 0 })[0].params
        .patch,
    ).toEqual({ start: 4, transitionIn: null, fadeIn: 0, transitionOut: null, fadeOut: 0 });
  });

  it("follows the timeline's rule: whole frames, at most half of the shorter clip", () => {
    const a = { ...clip, id: "a", start: 0 };
    // 0.12s clip: the overlap is half of it (0.06s), not a 0.1s floor.
    const short = { ...clip, duration: 0.12 };
    const film = { ...project([a, short]), fps: 24 } as Project;
    const [tiny] = joinTransitionCommands(film, short, "dissolve", 0.5);
    expect((tiny.params.patch as Clip).transitionIn!.duration).toBeCloseTo(0.06);
    // 0.5s is 12 frames at 24fps and 11.988 at 23.976: rounded to 12 frames there.
    const ntsc = { ...project([a, clip]), fps: 23.976 } as Project;
    const [first] = joinTransitionCommands(ntsc, clip, "dissolve", 0.5);
    expect((first.params.patch as Clip).transitionIn!.duration).toBeCloseTo(12 / 23.976);
    expect((first.params.patch as Clip).start).toBeCloseTo(4 - 12 / 23.976);
  });
});

describe("keyframes", () => {
  it("reads base values, short property names and volume", () => {
    expect(valueAt(clip, "transform.x", 1)).toBe(10);
    expect(valueAt(clip, "volume", 1)).toBe(0.8);
    const legacy = {
      ...clip,
      keyframes: [
        { property: "scale", time: 0, value: 1 },
        { property: "scale", time: 2, value: 3, easing: "hold" as const },
        { property: "scale", time: 4, value: 5 },
      ],
    };
    expect(valueAt(legacy, "transform.scale", 1)).toBe(2);
    expect(valueAt(legacy, "transform.scale", 3)).toBe(3);
  });

  it("replaces a keyframe within half a frame, keeping its name and easing", () => {
    const animated = {
      ...clip,
      keyframes: [{ property: "scale", time: 1, value: 1, easing: "easeOut" as const }],
    };
    expect(
      withKeyframe(animated, { property: "transform.scale", time: 1.01, value: 2 }, 30),
    ).toEqual([{ property: "scale", time: 1.01, value: 2, easing: "easeOut" }]);
  });

  it("drops linear easing and merges a keyframe moved onto another", () => {
    const first = { property: "transform.x", time: 0, value: 0, easing: "easeIn" as const };
    const second = { property: "transform.x", time: 2, value: 50 };
    const animated = { ...clip, keyframes: [first, second] };
    expect(withKeyframeChange(animated, first, { easing: "linear" }, 30)).toEqual([
      { property: "transform.x", time: 0, value: 0 },
      second,
    ]);
    expect(withKeyframeChange(animated, first, { time: 2 }, 30)).toEqual([
      { ...first, time: 2 },
    ]);
  });
});

describe("animation presets", () => {
  it("round-trips every preset at both edges and keeps volume keyframes", () => {
    const base = { ...clip, keyframes: [{ property: "volume", time: 0, value: 0.2 }] };
    for (const edge of ["in", "out"] as const)
      for (const preset of animationPresets) {
        const keyframes = animationPresetKeyframes(base, project([]), edge, preset, 0.5);
        const animated = { ...base, keyframes };
        expect(activeAnimationPreset(animated, project([]), edge)?.id).toBe(preset.id);
        expect(keyframes.every((k) => k.time >= 0 && k.time <= clip.duration)).toBe(true);
        expect(animationPresetKeyframes(animated, project([]), edge, null, 0.5)).toEqual(
          base.keyframes,
        );
      }
  });

  it("slides from outside the frame to the clip's own position", () => {
    const left = animationPresets.find((p) => p.id === "left")!;
    expect(animationPresetKeyframes(clip, project([]), "in", left, 1)).toEqual([
      { property: "transform.x", time: 0, value: -1910, easing: "easeOut" },
      { property: "transform.x", time: 1, value: 10 },
    ]);
  });
});

describe("animation presets beside other keyframes", () => {
  const preset = (id: string) => animationPresets.find((p) => p.id === id)!;
  const apply = (
    value: Clip,
    edge: "in" | "out",
    id: string | null,
    length = 0.5,
  ): Clip => ({
    ...value,
    keyframes: animationPresetKeyframes(value, project([]), edge, id ? preset(id) : null, length),
  });

  it("leaves keyframes of properties the preset does not use", () => {
    // Library "천천히 축소": scale 1.08 -> 1 over the whole clip, plus a user rotation key.
    const zoom = [
      { property: "transform.scale", time: 0, value: 1.08 },
      { property: "transform.rotation", time: 0.2, value: 15 },
      { property: "transform.scale", time: 4, value: 1 },
    ];
    const base = { ...clip, keyframes: zoom };
    const faded = apply(base, "in", "fade");
    expect(faded.keyframes.filter((k) => k.property !== "transform.opacity")).toEqual(zoom);
    expect(valueAt(faded, "transform.scale", 0)).toBeCloseTo(1.08);
    expect(apply(apply(base, "out", "left"), "out", null).keyframes).toEqual(zoom);
  });

  it("removes nothing when there is no preset at that edge", () => {
    const user = [
      { property: "transform.x", time: 0, value: 300 },
      { property: "transform.x", time: 0.3, value: 120 },
      { property: "transform.y", time: 3.9, value: 40 },
      { property: "transform.y", time: 4, value: 80 },
    ];
    const base = { ...clip, keyframes: user };
    expect(activeAnimationPreset(base, project([]), "in")).toBeNull();
    expect(apply(base, "in", null).keyframes).toEqual(user);
    expect(apply(base, "out", null).keyframes).toEqual(user);
  });

  it("keeps both edges when their animations meet in the middle of the clip", () => {
    const short = { ...clip, duration: 1 };
    // In fade, then an out slide: the fade's end keyframe at 0.5s must survive.
    const slid = apply(apply(short, "in", "fade"), "out", "left");
    expect(valueAt(slid, "transform.opacity", 0)).toBe(0);
    expect(valueAt(slid, "transform.opacity", 0.5)).toBe(1);
    expect(valueAt(slid, "transform.opacity", 1)).toBe(1);
    expect(valueAt(slid, "transform.x", 0.25)).toBe(10);
    expect(valueAt(slid, "transform.x", 1)).toBe(-1910);
    // Removing the in preset leaves the out preset complete.
    const outOnly = apply(slid, "in", null);
    expect(outOnly.keyframes).toEqual(apply(short, "out", "left").keyframes);

    // The same property on both edges shares the middle keyframe.
    const both = apply(apply(short, "in", "fade"), "out", "fade");
    expect([0, 0.25, 0.5, 1].map((t) => valueAt(both, "transform.opacity", t))).toEqual([
      0,
      expect.any(Number),
      1,
      0,
    ]);
    expect(both.keyframes).toHaveLength(3);
    expect(activeAnimationPreset(both, project([]), "in")?.id).toBe("fade");
    expect(activeAnimationPreset(both, project([]), "out")?.id).toBe("fade");
    const removedIn = apply(both, "in", null);
    expect(valueAt(removedIn, "transform.opacity", 0)).toBe(1);
    expect(valueAt(removedIn, "transform.opacity", 1)).toBe(0);
    const removedOut = apply(both, "out", null);
    expect(valueAt(removedOut, "transform.opacity", 0)).toBe(0);
    expect(valueAt(removedOut, "transform.opacity", 1)).toBe(1);
  });
});

describe("bundled assets", () => {
  it("ships every sticker as a 512px PNG with an alpha channel", () => {
    expect(stickers.length).toBeGreaterThanOrEqual(12);
    for (const sticker of stickers) {
      const png = readFileSync(`public/stickers/${sticker.file}`) as {
        subarray(a: number, b: number): { toString(): string };
        readUInt32BE(offset: number): number;
        [index: number]: number;
      };
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
      expect(png[25]).toBe(6);
    }
  });

  it("keeps text preset styles inside the editor's limits", () => {
    for (const { style } of textPresets) {
      expect(style.letterSpacing ?? 0).toBeGreaterThanOrEqual(-5);
      expect(style.letterSpacing ?? 0).toBeLessThanOrEqual(50);
      expect(style.lineHeight ?? 1.2).toBeGreaterThanOrEqual(0.8);
      expect(style.lineHeight ?? 1.2).toBeLessThanOrEqual(3);
      expect(style.outline?.width ?? 0).toBeLessThanOrEqual(20);
      expect(style.shadow?.blur ?? 0).toBeLessThanOrEqual(40);
    }
  });
});
