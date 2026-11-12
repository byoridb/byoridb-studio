import { describe, expect, it } from "vitest";
import { animatedValue, blendModeStyle, cropLayout, easeProgress, maskStyle, textStyle, transitionEffect } from "./fastPreview";
import type { Clip } from "./types";

const clip = (extra: Partial<Clip> = {}): Clip => ({
  id: "c", trackId: "v", name: "c", kind: "image", start: 0, duration: 4, sourceIn: 0, speed: 1, reverse: false,
  volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [], ...extra,
});

describe("keyframe easing", () => {
  it("matches the contract curves", () => {
    expect(easeProgress(0.5)).toBe(0.5);
    expect(easeProgress(0.5, "linear")).toBe(0.5);
    expect(easeProgress(0.5, "easeIn")).toBe(0.25);
    expect(easeProgress(0.5, "easeOut")).toBe(0.75);
    expect(easeProgress(0.25, "easeInOut")).toBeCloseTo(3 * 0.0625 - 2 * 0.015625);
    expect(easeProgress(0.99, "hold")).toBe(0);
    expect(easeProgress(1, "hold")).toBe(1);
  });
  it("eases each segment by the keyframe that starts it and stays linear without easing", () => {
    const keys = (easing?: "easeIn" | "hold") => clip({ keyframes: [
      { property: "x", time: 0, value: 0, ...(easing ? { easing } : {}) },
      { property: "transform.x", time: 2, value: 100 },
      { property: "x", time: 4, value: 300, easing: "easeIn" },
    ] });
    expect(animatedValue(keys(), "x", 1, 7)).toBe(50);
    expect(animatedValue(keys("easeIn"), "x", 1, 7)).toBe(25);
    expect(animatedValue(keys("hold"), "x", 1.99, 7)).toBe(0);
    expect(animatedValue(keys("hold"), "x", 2, 7)).toBe(100);
    // The second segment has no easing of its own; the last keyframe's easing has no next segment.
    expect(animatedValue(keys("hold"), "x", 3, 7)).toBe(200);
    expect(animatedValue(keys("easeIn"), "x", 9, 7)).toBe(300);
    expect(animatedValue(clip(), "x", 1, 7)).toBe(7);
    // A first keyframe after zero animates from the static value, linearly.
    expect(animatedValue(clip({ keyframes: [{ property: "x", time: 2, value: 10, easing: "hold" }] }), "x", 1, 0)).toBe(5);
  });
});

describe("transition approximation", () => {
  it("fades, wipes, slides and zooms a clip in and out", () => {
    expect(transitionEffect(clip(), 1, 1920)).toEqual({ opacity: 1, x: 0, y: 0, scale: 1 });
    expect(transitionEffect(clip({ transitionIn: { type: "dissolve", duration: 2 } }), 0.5, 1920).opacity).toBe(0.25);
    expect(transitionEffect(clip({ transitionOut: { type: "fade", duration: 2 } }), 3.5, 1920).opacity).toBe(0.25);
    expect(transitionEffect(clip({ transitionIn: { type: "wipeLeft", duration: 2 } }), 0.5, 1920).clipPath).toBe("inset(0 0 0 75%)");
    expect(transitionEffect(clip({ transitionIn: { type: "wipeRight", duration: 2 } }), 0.5, 1920).clipPath).toBe("inset(0 75% 0 0)");
    expect(transitionEffect(clip({ transitionIn: { type: "wipeUp", duration: 2 } }), 1, 1920).clipPath).toBe("inset(50% 0 0 0)");
    expect(transitionEffect(clip({ transitionOut: { type: "wipeDown", duration: 2 } }), 3, 1920).clipPath).toBe("inset(50% 0 0 0)");
    expect(transitionEffect(clip({ transitionIn: { type: "slideLeft", duration: 2 } }), 0.5, 1920).x).toBe(1440);
    expect(transitionEffect(clip({ transitionOut: { type: "slideLeft", duration: 2 } }), 3.5, 1920).x).toBe(-1440);
    expect(transitionEffect(clip({ transitionIn: { type: "slideRight", duration: 2 } }), 1, 1920).x).toBe(-960);
    // Away from the centre a layer still starts just outside the edge it enters from.
    expect(transitionEffect(clip({ transitionIn: { type: "slideLeft", duration: 2 } }), 0, 1920, 480, 600).x).toBe(600);
    expect(transitionEffect(clip({ transitionIn: { type: "slideRight", duration: 2 } }), 0, 1920, 480, 600).x).toBe(-1800);
    expect(transitionEffect(clip({ transitionOut: { type: "slideLeft", duration: 2 } }), 4, 1920, 480, -1300).x).toBe(0);
    const zoom = transitionEffect(clip({ transitionIn: { type: "zoom", duration: 2 } }), 1, 1920);
    expect(zoom.scale).toBeCloseTo(0.9);
    expect(zoom.opacity).toBe(0.5);
    // Past the transition nothing is applied.
    expect(transitionEffect(clip({ transitionIn: { type: "wipeLeft", duration: 1 } }), 2, 1920).clipPath).toBeUndefined();
  });
  it("keeps the alpha fade of a legacy clip that has fades but no transition metadata", () => {
    expect(transitionEffect(clip({ fadeIn: 2 }), 1, 1920).opacity).toBe(0.5);
    expect(transitionEffect(clip({ fadeOut: 2 }), 3, 1920).opacity).toBe(0.5);
    // A non-alpha transition does not also fade the picture; its fade drives audio only.
    expect(transitionEffect(clip({ fadeIn: 2, transitionIn: { type: "slideLeft", duration: 2 } }), 1, 1920).opacity).toBe(1);
  });
});

describe("layer styles", () => {
  it("maps blend modes, leaving normal and unknown modes alone", () => {
    expect(blendModeStyle(clip())).toBeUndefined();
    expect(blendModeStyle(clip({ blendMode: "normal" }))).toBeUndefined();
    expect(blendModeStyle(clip({ blendMode: "screen" }))).toBe("screen");
    expect(blendModeStyle(clip({ blendMode: "add" }))).toBe("plus-lighter");
  });
  it("fits the cropped source into the stage like the export", () => {
    const layout = cropLayout({ width: 1920, height: 1080 }, { x: 0.5, y: 0, width: 0.5, height: 1 }, { width: 640, height: 360 })!;
    expect(layout.frame).toEqual({ width: 320, height: 360 });
    expect(layout.media).toEqual({ width: 640, height: 360, left: -320, top: -0 });
    expect(cropLayout({ width: 1000, height: 1000 }, undefined, { width: 640, height: 360 })!.frame).toEqual({ width: 360, height: 360 });
    expect(cropLayout({ width: 0, height: 0 }, undefined, { width: 640, height: 360 })).toBeNull();
    expect(cropLayout(undefined, undefined, { width: 640, height: 360 })).toBeNull();
  });
  it("draws rectangle and ellipse masks, feathered inwards", () => {
    expect(maskStyle(undefined)).toEqual({});
    expect(maskStyle({ type: "none", x: 0.5, y: 0.5, width: 1, height: 1, feather: 0 })).toEqual({});
    expect(maskStyle({ type: "rectangle", x: 0.5, y: 0.5, width: 0.5, height: 0.4, feather: 0 }).clipPath).toBe("inset(30% 25% 30% 25%)");
    expect(maskStyle({ type: "circle", x: 0.5, y: 0.5, width: 0.5, height: 1, feather: 0 }).clipPath).toBe("ellipse(25% 50% at 50% 50%)");
    expect(maskStyle({ type: "circle", x: 0.5, y: 0.5, width: 1, height: 1, feather: 0.2 }).maskImage)
      .toBe("radial-gradient(ellipse 50% 50% at 50% 50%, #000 80%, transparent 100%)");
    const soft = maskStyle({ type: "rectangle", x: 0.5, y: 0.5, width: 1, height: 1, feather: 0.5 });
    expect(soft.maskComposite).toBe("intersect");
    expect(soft.maskImage).toContain("linear-gradient(to right, transparent 0%, #000 25%, #000 75%, transparent 100%)");
  });
  it("styles text with the shared wrap rule and optional fields", () => {
    const base = { content: "가", fontSize: 60, color: "#fff", fontFamily: "Pretendard", bold: false, align: "center", background: "" };
    const plain = textStyle(base, 0.5, 1920);
    expect(plain).toMatchObject({ fontSize: 30, fontStyle: "normal", lineHeight: 1.2, maxWidth: 864, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "normal" });
    expect(plain.letterSpacing).toBeUndefined();
    expect(plain.textShadow).toBeUndefined();
    expect(plain.WebkitTextStroke).toBeUndefined();
    const rich = textStyle({ ...base, italic: true, letterSpacing: 4, lineHeight: 1.5, outline: { color: "#000", width: 3 }, shadow: { color: "#0008", x: 2, y: 4, blur: 6 } }, 0.5, 1920);
    expect(rich).toMatchObject({ fontStyle: "italic", letterSpacing: 2, lineHeight: 1.5, WebkitTextStroke: "3px #000", paintOrder: "stroke fill", textShadow: "1px 2px 3px #0008" });
    expect(textStyle({ ...base, outline: { color: "#000", width: 0 } }, 1, 1920).WebkitTextStroke).toBeUndefined();
  });
});
