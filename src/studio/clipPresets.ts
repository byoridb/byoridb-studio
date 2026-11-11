import { junctionTransitionCommands } from "./clipEditing";
import { animatedValue } from "./fastPreview";
import type {
  BlendMode,
  Clip,
  Easing,
  Keyframe,
  Project,
  Transition,
  TransitionType,
} from "./types";

export type Edge = "in" | "out";
type Patch = Record<string, unknown>;
export interface EditCommand {
  method: string;
  params: Record<string, unknown>;
}

export const transitionCatalog: { id: TransitionType; name: string }[] = [
  { id: "fade", name: "페이드" },
  { id: "dissolve", name: "디졸브" },
  { id: "wipeLeft", name: "왼쪽 와이프" },
  { id: "wipeRight", name: "오른쪽 와이프" },
  { id: "wipeUp", name: "위로 와이프" },
  { id: "wipeDown", name: "아래로 와이프" },
  { id: "slideLeft", name: "왼쪽 슬라이드" },
  { id: "slideRight", name: "오른쪽 슬라이드" },
  { id: "zoom", name: "줌" },
];
/** Audio clips only fade. */
export const transitionsFor = (clip: Clip | null) =>
  clip?.kind === "audio" ? transitionCatalog.slice(0, 1) : transitionCatalog;

export const blendModes: { id: BlendMode; name: string }[] = [
  { id: "normal", name: "일반" },
  { id: "multiply", name: "곱하기" },
  { id: "screen", name: "스크린" },
  { id: "overlay", name: "오버레이" },
  { id: "darken", name: "어둡게" },
  { id: "lighten", name: "밝게" },
  { id: "add", name: "더하기" },
];

export const easings: { id: Easing; name: string }[] = [
  { id: "linear", name: "일정하게" },
  { id: "easeIn", name: "천천히 시작" },
  { id: "easeOut", name: "천천히 끝" },
  { id: "easeInOut", name: "부드럽게" },
  { id: "hold", name: "유지" },
];

const transitionKey = (edge: Edge) =>
  edge === "in" ? "transitionIn" : "transitionOut";
const fadeKey = (edge: Edge) => (edge === "in" ? "fadeIn" : "fadeOut");
export const transitionOf = (clip: Clip, edge: Edge): Transition | null =>
  clip[transitionKey(edge)] ?? null;

/** The fade length stays equal to the transition length: it drives the audio fade. */
export function transitionPatch(
  clip: Clip,
  edge: Edge,
  type: TransitionType | null,
  duration: number,
): Patch {
  if (!type) return { [transitionKey(edge)]: null, [fadeKey(edge)]: 0 };
  const other = edge === "in" ? clip.fadeOut : clip.fadeIn;
  const length = Math.max(
    0.1,
    Math.min(duration, Math.max(0.1, clip.duration - other)),
  );
  return {
    [transitionKey(edge)]: { type, duration: length },
    [fadeKey(edge)]: length,
  };
}

const epsilon = 1e-6;
const sameTrack = (project: Project, clip: Clip) =>
  project.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id);
/** The same-track clip this clip follows: touching it, or already overlapping it. */
export function previousClip(project: Project, clip: Clip): Clip | null {
  const frame = 1 / Math.max(1, project.fps);
  return (
    sameTrack(project, clip)
      .filter(
        (c) =>
          c.start < clip.start - epsilon &&
          c.start + c.duration >= clip.start - frame / 2,
      )
      .sort((a, b) => b.start - a.start)[0] ?? null
  );
}
export function overlapWithPrevious(project: Project, clip: Clip): number {
  const previous = previousClip(project, clip);
  if (!previous) return 0;
  const overlap = previous.start + previous.duration - clip.start;
  return overlap > 1 / Math.max(1, project.fps) / 2 ? overlap : 0;
}
const withClipPatch = (
  commands: EditCommand[],
  clip: Clip,
  patch: Patch,
): EditCommand[] => {
  const own = commands.find((c) => c.params.id === clip.id);
  if (!own)
    return [{ method: "edit.update", params: { id: clip.id, patch } }, ...commands];
  return commands.map((c) =>
    c === own
      ? { ...c, params: { ...c.params, patch: { ...(c.params.patch as Patch), ...patch } } }
      : c,
  );
};

/**
 * Sets, changes or removes the transition between a clip and the one before it,
 * by the timeline's rule (clipEditing.junctionTransitionCommands): the overlap
 * always equals the transition length, a whole number of frames and at most half
 * of the shorter clip. Audio clips only fade.
 */
export function incomingTransitionCommands(
  project: Project,
  clip: Clip,
  transition: { type: TransitionType; duration: number } | null,
): EditCommand[] {
  const before = previousClip(project, clip);
  if (!before) return [];
  const commands = junctionTransitionCommands(
    project,
    { before, after: clip },
    transition && {
      type: clip.kind === "audio" ? "fade" : transition.type,
      duration: transition.duration,
    },
  );
  const own = commands.find((c) => c.params.id === clip.id);
  const set = (own?.params.patch as Patch | undefined)?.transitionIn as
    | Transition
    | null
    | undefined;
  if (!transition) return withClipPatch(commands, clip, { transitionIn: null, fadeIn: 0 });
  return set ? withClipPatch(commands, clip, { fadeIn: set.duration }) : commands;
}

/**
 * A transition between two clips: this clip and everything after it on the track
 * move earlier by the transition length, so it enters over the previous clip.
 */
export function joinTransitionCommands(
  project: Project,
  clip: Clip,
  type: TransitionType,
  duration: number,
): EditCommand[] {
  if (overlapWithPrevious(project, clip) > 0) return [];
  return incomingTransitionCommands(project, clip, { type, duration });
}

/**
 * Undoes `joinTransitionCommands`: the clips move back and the transition is
 * removed. `extra` is merged into the clip's own patch (the section reset also
 * clears the out transition).
 */
export function separateTransitionCommands(
  project: Project,
  clip: Clip,
  extra: Patch = {},
): EditCommand[] {
  if (!overlapWithPrevious(project, clip)) return [];
  return withClipPatch(incomingTransitionCommands(project, clip, null), clip, extra);
}

export interface KeyframeProperty {
  id: string;
  label: string;
  unit: string;
  /** Displayed value = stored value × factor. */
  factor: number;
  min: number;
  max: number;
  step: number;
}
export const keyframeProperties: KeyframeProperty[] = [
  { id: "transform.x", label: "위치 X", unit: "px", factor: 1, min: -20000, max: 20000, step: 1 },
  { id: "transform.y", label: "위치 Y", unit: "px", factor: 1, min: -20000, max: 20000, step: 1 },
  { id: "transform.scale", label: "크기", unit: "%", factor: 100, min: 1, max: 2000, step: 1 },
  { id: "transform.rotation", label: "회전", unit: "°", factor: 1, min: -3600, max: 3600, step: 1 },
  { id: "transform.opacity", label: "불투명도", unit: "%", factor: 100, min: 0, max: 100, step: 1 },
  { id: "volume", label: "볼륨", unit: "%", factor: 100, min: 0, max: 400, step: 1 },
];
/** Stored keyframes may use the short form (`scale`) of a transform property. */
export const canonicalProperty = (property: string) =>
  property === "volume" || property.startsWith("transform.")
    ? property
    : `transform.${property}`;
export const propertyInfo = (property: string) =>
  keyframeProperties.find((p) => p.id === canonicalProperty(property));

export const localTime = (clip: Clip, playhead: number) =>
  Math.max(0, Math.min(clip.duration, playhead - clip.start));

const framesOf = (clip: Clip, property: string) =>
  (clip.keyframes || [])
    .filter((k) => canonicalProperty(k.property) === property)
    .sort((a, b) => a.time - b.time);

/** The value a property has at a clip-local time, exactly as the preview animates it. */
export function valueAt(clip: Clip, property: string, time: number): number {
  const short = property.replace(/^transform\./, "");
  const base =
    property === "volume"
      ? clip.volume
      : ((clip.transform as Record<string, unknown>)[short] as number);
  return animatedValue(clip, short, time, base);
}

const sorted = (frames: Keyframe[]) =>
  [...frames].sort((a, b) => a.time - b.time);
const near = (fps: number) => 1 / Math.max(1, fps) / 2;

export function keyframeAt(
  clip: Clip,
  property: string,
  time: number,
  fps: number,
): Keyframe | undefined {
  return framesOf(clip, property).find(
    (k) => Math.abs(k.time - time) <= near(fps),
  );
}

/** Adds a keyframe, replacing one of the same property within half a frame. */
export function withKeyframe(
  clip: Clip,
  frame: Keyframe,
  fps: number,
): Keyframe[] {
  const property = canonicalProperty(frame.property);
  const replaced = keyframeAt(clip, property, frame.time, fps);
  return sorted([
    ...(clip.keyframes || []).filter((k) => k !== replaced),
    {
      ...(replaced?.easing ? { easing: replaced.easing } : {}),
      ...frame,
      property: replaced?.property ?? frame.property,
    },
  ]);
}

/** Changes one keyframe in place; a moved keyframe replaces one it lands on. */
export function withKeyframeChange(
  clip: Clip,
  target: Keyframe,
  change: Partial<Pick<Keyframe, "time" | "value" | "easing">>,
  fps: number,
): Keyframe[] {
  const next: Keyframe = { ...target, ...change };
  if (next.easing === "linear") delete next.easing;
  next.time = Math.max(0, Math.min(clip.duration, next.time));
  const property = canonicalProperty(target.property);
  return sorted([
    ...(clip.keyframes || []).filter(
      (k) =>
        k !== target &&
        !(
          canonicalProperty(k.property) === property &&
          Math.abs(k.time - next.time) <= near(fps)
        ),
    ),
    next,
  ]);
}

type Motion = Partial<
  Record<"x" | "y" | "scale" | "rotation" | "opacity", number>
>;
export interface AnimationPreset {
  id: string;
  name: string;
  /** The off-screen state; x/y are fractions of the frame added to the position, scale multiplies, opacity and rotation are absolute offsets. */
  motion: Motion;
}
export const animationPresets: AnimationPreset[] = [
  { id: "fade", name: "페이드", motion: { opacity: 0 } },
  { id: "zoomIn", name: "확대", motion: { scale: 0.6, opacity: 0 } },
  { id: "zoomOut", name: "축소", motion: { scale: 1.4, opacity: 0 } },
  { id: "left", name: "왼쪽", motion: { x: -1 } },
  { id: "right", name: "오른쪽", motion: { x: 1 } },
  { id: "up", name: "위", motion: { y: -1 } },
  { id: "down", name: "아래", motion: { y: 1 } },
  { id: "spin", name: "회전", motion: { rotation: -90, opacity: 0 } },
];
const motionProperties = ["x", "y", "scale", "rotation", "opacity"] as const;

const edgeTime = (clip: Clip, edge: Edge) => (edge === "in" ? 0 : clip.duration);
const restValue = (clip: Clip, key: (typeof motionProperties)[number]) =>
  clip.transform[key];

/**
 * Keyframes of the clip without the edge animation of the given transform
 * properties: the keyframe at the edge itself and its pair (the neighbouring
 * keyframe that returns to the clip's own value). Other properties, keyframes
 * away from the edge and a pair shared with the other edge's animation stay.
 */
function withoutEdgeAnimation(
  clip: Clip,
  edge: Edge,
  keys: Iterable<(typeof motionProperties)[number]>,
) {
  const removed = new Set<Keyframe>();
  for (const key of keys) {
    const frames = framesOf(clip, `transform.${key}`);
    if (edge === "out") frames.reverse();
    const [atEdge, pair, beyond] = frames;
    if (!atEdge || Math.abs(atEdge.time - edgeTime(clip, edge)) > epsilon) continue;
    removed.add(atEdge);
    const far = edgeTime(clip, edge === "in" ? "out" : "in");
    if (
      pair &&
      Math.abs(pair.value - restValue(clip, key)) < 1e-4 &&
      Math.abs(pair.time - far) > epsilon &&
      !(beyond && Math.abs(beyond.time - far) < epsilon)
    )
      removed.add(pair);
  }
  return (clip.keyframes || []).filter((k) => !removed.has(k));
}

/**
 * An in/out animation as ordinary keyframes: the clip travels between the
 * preset's off-screen state and its own transform over `duration` seconds.
 * It replaces the preset already at that edge; `null` only removes that one.
 * Keyframes of properties neither preset uses are left alone.
 */
export function animationPresetKeyframes(
  clip: Clip,
  project: Pick<Project, "width" | "height">,
  edge: Edge,
  preset: AnimationPreset | null,
  duration: number,
): Keyframe[] {
  const length = Math.min(Math.max(0.1, duration), clip.duration / 2);
  const current = activeAnimationPreset(clip, project, edge);
  const keys = motionProperties.filter(
    (key) =>
      preset?.motion[key] !== undefined || current?.motion[key] !== undefined,
  );
  let kept = withoutEdgeAnimation(clip, edge, keys);
  if (!preset) return sorted(kept);
  const added: Keyframe[] = [];
  for (const key of motionProperties) {
    const amount = preset.motion[key];
    if (amount === undefined) continue;
    const rest = restValue(clip, key);
    const away =
      key === "x"
        ? rest + amount * project.width
        : key === "y"
          ? rest + amount * project.height
          : key === "scale"
            ? rest * amount
            : key === "rotation"
              ? rest + amount
              : amount;
    const property = `transform.${key}`;
    const pairTime = edge === "in" ? length : clip.duration - length;
    // The two edges can meet (length = half the clip): the keyframe already
    // there is replaced, and the other edge's easing out of it survives.
    const existing = kept.find(
      (k) =>
        canonicalProperty(k.property) === property &&
        Math.abs(k.time - pairTime) < epsilon,
    );
    kept = kept.filter((k) => k !== existing);
    if (edge === "in")
      added.push(
        { property, time: 0, value: away, easing: "easeOut" },
        {
          property,
          time: pairTime,
          value: rest,
          ...(existing?.easing ? { easing: existing.easing } : {}),
        },
      );
    else
      added.push(
        { property, time: pairTime, value: rest, easing: "easeIn" },
        { property, time: clip.duration, value: away },
      );
  }
  return sorted([...kept, ...added]);
}

/**
 * The preset whose off-screen state sits at that edge, if any: the one using
 * the most properties, so keyframes of other properties do not hide it.
 */
export function activeAnimationPreset(
  clip: Clip,
  project: Pick<Project, "width" | "height">,
  edge: Edge,
): AnimationPreset | null {
  const time = edgeTime(clip, edge);
  const at = (clip.keyframes || []).filter(
    (k) =>
      canonicalProperty(k.property) !== "volume" &&
      Math.abs(k.time - time) < epsilon,
  );
  if (!at.length) return null;
  const size = (preset: AnimationPreset) => Object.keys(preset.motion).length;
  return (
    [...animationPresets]
      .sort((a, b) => size(b) - size(a))
      .find((preset) =>
        animationPresetKeyframes(
          { ...clip, keyframes: [] },
          project,
          edge,
          preset,
          clip.duration,
        )
          .filter((k) => Math.abs(k.time - time) < epsilon)
          .every((e) =>
            at.some(
              (k) =>
                canonicalProperty(k.property) === e.property &&
                Math.abs(k.value - e.value) < 1e-4,
            ),
          ),
      ) ?? null
  );
}

export const textDefaults = {
  fontSize: 64,
  color: "#ffffff",
  fontFamily: "Arial",
  bold: false,
  align: "center",
  background: "transparent",
};
export const outlineOff = { color: "#000000", width: 0 };
export const shadowOff = { color: "#000000", x: 0, y: 0, blur: 0 };
export const shadowOn = (shadow?: { x: number; y: number; blur: number }) =>
  !!shadow && (shadow.x !== 0 || shadow.y !== 0 || shadow.blur !== 0);

export interface TextPreset {
  name: string;
  label: string;
  style: Partial<NonNullable<Clip["text"]>>;
}
export const textPresets: TextPreset[] = [
  {
    name: "타이틀",
    label: "제목을 입력하세요",
    style: {
      fontSize: 96,
      bold: true,
      letterSpacing: -1,
      shadow: { color: "#000000", x: 0, y: 4, blur: 14 },
    },
  },
  {
    name: "시네마",
    label: "작은 순간, 오래 남는 기억",
    style: { fontSize: 44, fontFamily: "Georgia", italic: true, letterSpacing: 2 },
  },
  {
    name: "하이라이트",
    label: "오늘의 기록",
    style: {
      fontSize: 72,
      bold: true,
      color: "#ffe76a",
      outline: { color: "#1b1b1b", width: 6 },
    },
  },
  {
    name: "자막",
    label: "여기에 자막을 입력하세요",
    style: { fontSize: 42, outline: { color: "#000000", width: 4 }, lineHeight: 1.3 },
  },
  {
    name: "자막 상자",
    label: "여기에 자막을 입력하세요",
    style: { fontSize: 40, background: "#18191de6", lineHeight: 1.4 },
  },
  {
    name: "챕터",
    label: "CHAPTER 01",
    style: { fontSize: 40, bold: true, letterSpacing: 12 },
  },
  {
    name: "네온",
    label: "TONIGHT",
    style: {
      fontSize: 84,
      bold: true,
      color: "#7ff6ff",
      letterSpacing: 4,
      shadow: { color: "#19c8ff", x: 0, y: 0, blur: 24 },
    },
  },
  {
    name: "미니멀",
    label: "이야기가 시작되는 곳",
    style: { fontSize: 36, letterSpacing: 6, lineHeight: 1.6 },
  },
];

export interface StickerAsset {
  id: string;
  name: string;
  file: string;
}
/** PNG artwork shipped in public/stickers (512px, transparent). */
export const stickers: StickerAsset[] = [
  ["arrow", "화살표"],
  ["arrow-curved", "곡선 화살표"],
  ["bubble", "말풍선"],
  ["thought", "생각 풍선"],
  ["star", "별"],
  ["heart", "하트"],
  ["check", "체크"],
  ["cross", "엑스"],
  ["burst", "강조"],
  ["bolt", "번개"],
  ["sparkle", "반짝임"],
  ["exclamation", "느낌표"],
  ["question", "물음표"],
  ["play", "재생"],
  ["pin", "위치 핀"],
  ["crown", "왕관"],
].map(([id, name]) => ({ id, name, file: `sticker-${id}.png` }));
export const stickerUrl = (sticker: StickerAsset) =>
  `${import.meta.env.BASE_URL}stickers/${sticker.file}`;
