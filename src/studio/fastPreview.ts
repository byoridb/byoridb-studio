import type { CSSProperties } from "react";
import type { Clip, Easing, Transition } from "./types";

/** CSS approximations of the renderer for the fast preview. Export stays authoritative. */

export function easeProgress(p: number, easing?: Easing | string) {
  const t = Math.max(0, Math.min(1, p));
  switch (easing) {
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return t * t * (3 - 2 * t);
    case "hold":
      return t >= 1 ? 1 : 0;
    default:
      return t;
  }
}

/** A keyframed value at a clip-local time; each segment eases by its first keyframe. */
export function animatedValue(
  clip: Clip,
  property: string,
  time: number,
  fallback: number,
) {
  const keys = (clip.keyframes || [])
    .filter(
      (k) => k.property === property || k.property === `transform.${property}`,
    )
    .sort((a, b) => a.time - b.time);
  if (!keys.length) return fallback;
  if (keys[0].time > 0) keys.unshift({ property, time: 0, value: fallback });
  if (time <= keys[0].time) return keys[0].value;
  for (let i = 1; i < keys.length; i++)
    if (time < keys[i].time) {
      const p =
        (time - keys[i - 1].time) / (keys[i].time - keys[i - 1].time || 1);
      return (
        keys[i - 1].value +
        (keys[i].value - keys[i - 1].value) * easeProgress(p, keys[i - 1].easing)
      );
    }
  return keys[keys.length - 1].value;
}

export interface TransitionEffect {
  opacity: number;
  /** Offset in project pixels. */
  x: number;
  y: number;
  scale: number;
  /** A reveal crop over the whole frame. */
  clipPath?: string;
}

const percent = (value: number) => `${+(value * 100).toFixed(3)}%`;

function apply(
  effect: TransitionEffect,
  transition: Transition,
  progress: number,
  entering: boolean,
  travel: number,
  x: number,
) {
  const p = Math.max(0, Math.min(1, progress));
  const rest = 1 - p;
  switch (transition.type) {
    case "fade":
    case "dissolve":
      effect.opacity *= p;
      break;
    case "zoom":
      effect.opacity *= p;
      effect.scale *= 0.8 + 0.2 * p;
      break;
    // A wipe reveals (or hides) along its direction of travel.
    case "wipeLeft":
      effect.clipPath = entering
        ? `inset(0 0 0 ${percent(rest)})`
        : `inset(0 ${percent(rest)} 0 0)`;
      break;
    case "wipeRight":
      effect.clipPath = entering
        ? `inset(0 ${percent(rest)} 0 0)`
        : `inset(0 0 0 ${percent(rest)})`;
      break;
    case "wipeUp":
      effect.clipPath = entering
        ? `inset(${percent(rest)} 0 0 0)`
        : `inset(0 0 ${percent(rest)} 0)`;
      break;
    case "wipeDown":
      effect.clipPath = entering
        ? `inset(0 0 ${percent(rest)} 0)`
        : `inset(${percent(rest)} 0 0 0)`;
      break;
    // A slide travels in its named direction: in from the far side, out past the near one.
    // `travel` is what moves a centred layer exactly off screen; a layer resting at
    // `x` from the centre starts just outside the same edge, as in the export.
    case "slideLeft":
    case "slideRight": {
      const sign = (transition.type === "slideLeft") === entering ? 1 : -1;
      effect.x += sign * rest * Math.max(0, travel - sign * x);
      break;
    }
  }
}

/**
 * The clip's own entrance/exit at a clip-local time. A clip without transition
 * metadata keeps the legacy alpha fade of fadeIn/fadeOut. `layerWidth` is the
 * clip's drawn width in project pixels (the frame width when unknown) and `x` its
 * horizontal offset from the centre at that time.
 */
export function transitionEffect(
  clip: Clip,
  local: number,
  projectWidth: number,
  layerWidth = projectWidth,
  x = 0,
): TransitionEffect {
  const travel = (projectWidth + layerWidth) / 2;
  const effect: TransitionEffect = { opacity: 1, x: 0, y: 0, scale: 1 };
  const enter = clip.transitionIn?.duration
    ? clip.transitionIn
    : clip.fadeIn > 0
      ? ({ type: "fade", duration: clip.fadeIn } as Transition)
      : null;
  const exit = clip.transitionOut?.duration
    ? clip.transitionOut
    : clip.fadeOut > 0
      ? ({ type: "fade", duration: clip.fadeOut } as Transition)
      : null;
  if (enter && local < enter.duration)
    apply(effect, enter, local / enter.duration, true, travel, x);
  if (exit && clip.duration - local < exit.duration)
    apply(effect, exit, (clip.duration - local) / exit.duration, false, travel, x);
  return effect;
}

const blendModes: Record<string, CSSProperties["mixBlendMode"]> = {
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  add: "plus-lighter",
};
export const blendModeStyle = (clip: Clip): CSSProperties["mixBlendMode"] =>
  blendModes[clip.blendMode ?? ""] ?? undefined;

/** The renderer's mask: a rectangle or ellipse in the fitted frame, fading inwards by `feather`. */
export function maskStyle(mask: Clip["mask"]): CSSProperties {
  if (!mask || mask.type === "none") return {};
  const x = mask.x ?? 0.5,
    y = mask.y ?? 0.5,
    w = Math.max(0.0001, (mask.width ?? 1) / 2),
    h = Math.max(0.0001, (mask.height ?? 1) / 2),
    feather = Math.max(0, Math.min(1, mask.feather ?? 0));
  if (mask.type === "circle") {
    if (!feather)
      return { clipPath: `ellipse(${percent(w)} ${percent(h)} at ${percent(x)} ${percent(y)})` };
    const image = `radial-gradient(ellipse ${percent(w)} ${percent(h)} at ${percent(x)} ${percent(y)}, #000 ${percent(1 - feather)}, transparent 100%)`;
    return { maskImage: image, WebkitMaskImage: image };
  }
  if (!feather)
    return {
      clipPath: `inset(${percent(Math.max(0, y - h))} ${percent(Math.max(0, 1 - x - w))} ${percent(Math.max(0, 1 - y - h))} ${percent(Math.max(0, x - w))})`,
    };
  const axis = (direction: string, centre: number, half: number) =>
    `linear-gradient(${direction}, transparent ${percent(centre - half)}, #000 ${percent(centre - half * (1 - feather))}, #000 ${percent(centre + half * (1 - feather))}, transparent ${percent(centre + half)})`;
  const image = `${axis("to right", x, w)}, ${axis("to bottom", y, h)}`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  };
}

/** Where the cropped source sits once fitted (contain) into the stage, in stage pixels. */
export function cropLayout(
  media: { width: number; height: number } | undefined,
  crop: Clip["crop"],
  stage: { width: number; height: number },
) {
  if (!media?.width || !media.height) return null;
  const c = {
    x: Math.max(0, Math.min(1, crop?.x ?? 0)),
    y: Math.max(0, Math.min(1, crop?.y ?? 0)),
    width: Math.max(0.001, Math.min(1, crop?.width ?? 1)),
    height: Math.max(0.001, Math.min(1, crop?.height ?? 1)),
  };
  const fit = Math.min(
    stage.width / (media.width * c.width),
    stage.height / (media.height * c.height),
  );
  return {
    frame: { width: media.width * c.width * fit, height: media.height * c.height * fit },
    media: {
      width: media.width * fit,
      height: media.height * fit,
      left: -c.x * media.width * fit,
      top: -c.y * media.height * fit,
    },
  };
}

/**
 * Text box rules shared with export: the text wraps at 90% of the frame (word
 * wrap, CJK and long words by character) and the background adds 12 project
 * pixels of padding around it.
 */
export function textStyle(
  text: Clip["text"],
  scale: number,
  projectWidth: number,
): CSSProperties {
  const size = (text?.fontSize || 64) * scale;
  const outline = text?.outline && text.outline.width > 0 ? text.outline : null;
  const shadow = text?.shadow;
  return {
    fontSize: size,
    color: text?.color || "#fff",
    fontFamily: text?.fontFamily || "sans-serif",
    fontWeight: text?.bold ? 700 : 400,
    fontStyle: text?.italic ? "italic" : "normal",
    letterSpacing: text?.letterSpacing ? text.letterSpacing * scale : undefined,
    lineHeight: text?.lineHeight ?? 1.2,
    textAlign: (text?.align || "center") as "center",
    background: text?.background || "transparent",
    whiteSpace: "pre-wrap",
    wordBreak: "normal",
    overflowWrap: "anywhere",
    width: "max-content",
    boxSizing: "content-box",
    maxWidth: projectWidth * 0.9 * scale,
    padding: 12 * scale,
    // The stroke is centred on the glyph edge; painting it first keeps the fill at full weight.
    ...(outline
      ? {
          WebkitTextStroke: `${outline.width * 2 * scale}px ${outline.color}`,
          paintOrder: "stroke fill",
        }
      : {}),
    ...(shadow
      ? {
          textShadow: `${shadow.x * scale}px ${shadow.y * scale}px ${shadow.blur * scale}px ${shadow.color}`,
        }
      : {}),
  };
}
