import type { Clip, Project } from "./types";
import { canEditSelection, selectedClips } from "./selection";

export type ClipEditAction = "split" | "trim-start" | "trim-end";
export interface ClipEditCommand {
  method: string;
  params: Record<string, unknown>;
}
const epsilon = 1e-7;
const frameDuration = (project: Project) => 1 / Math.max(1, project.fps);
const frameTime = (project: Project, time: number) =>
  Math.round(time / frameDuration(project)) * frameDuration(project);

/** The playhead actions affect only selected clips crossing the cut position. */
export function clipEditCommands(project: Project, ids: string[], time: number, action: ClipEditAction): ClipEditCommand[] {
  if (!Number.isFinite(time) || !canEditSelection(project, ids)) return [];
  const cut = frameTime(project, time), minimum = frameDuration(project);
  return selectedClips(project, ids)
    .filter((clip) => cut - clip.start >= minimum - epsilon && clip.start + clip.duration - cut >= minimum - epsilon)
    .map((clip) => action === "split"
      ? { method: "edit.split", params: { id: clip.id, time: cut } }
      : { method: "edit.trim", params: { id: clip.id, ...(action === "trim-start" ? { start: cut } : { end: cut }) } });
}

/** A bounded draft; callers resolve pointer snapping or exact keyboard nudges first. */
export function trimClipPreview(project: Project, clip: Clip, edge: "start" | "end", target: number): Partial<Clip> | null {
  if (!Number.isFinite(target) || !canEditSelection(project, [clip.id])) return null;
  const minimum = frameDuration(project), oldEnd = clip.start + clip.duration;
  const finiteSource = clip.kind === "video" || clip.kind === "audio";
  const media = project.media.find((item) => item.id === clip.mediaId);
  if (finiteSource && (!media || !Number.isFinite(media.duration) || media.duration <= 0 || clip.speed <= 0)) return null;
  const availableAfter = finiteSource ? Math.max(0, media!.duration - clip.sourceIn - clip.duration * clip.speed) / clip.speed : Infinity;
  const availableBefore = finiteSource ? clip.sourceIn / clip.speed : Infinity;
  const earliest = Math.max(0, clip.start - (clip.reverse ? availableAfter : availableBefore));
  const latest = oldEnd + (clip.reverse ? availableBefore : availableAfter);
  const cut = target;
  const start = edge === "start" ? Math.max(earliest, Math.min(oldEnd - minimum, cut)) : clip.start;
  const end = edge === "end" ? Math.min(latest, Math.max(clip.start + minimum, cut)) : oldEnd;
  if (end - start < minimum - epsilon || (Math.abs(start - clip.start) < epsilon && Math.abs(end - oldEnd) < epsilon)) return null;
  const sourceIn = finiteSource
    ? Math.max(0, clip.sourceIn + (clip.reverse ? oldEnd - end : start - clip.start) * clip.speed)
    : clip.sourceIn;
  return { start, duration: end - start, sourceIn };
}

const animates = (property: string) => (key: Clip["keyframes"][number]) =>
  key.property === property || key.property === `transform.${property}`;

/**
 * A canvas move/scale edits what is on screen. An animated property is written
 * as a keyframe at the playhead (replacing one within half a frame); a static
 * property is written to the transform.
 */
export function canvasTransformPatch(
  clip: Clip,
  values: Partial<Record<"x" | "y" | "scale", number>>,
  time: number,
  fps: number,
): Partial<Clip> {
  const local = Math.max(0, Math.min(clip.duration, time - clip.start));
  const transform = { ...clip.transform };
  let keyframes = clip.keyframes || [];
  let animated = false;
  for (const [property, value] of Object.entries(values) as ["x" | "y" | "scale", number][]) {
    const matches = animates(property);
    const existing = keyframes.filter(matches);
    if (!existing.length) { transform[property] = value; continue; }
    animated = true;
    keyframes = [
      ...keyframes.filter((key) => !matches(key) || Math.abs(key.time - local) > 1 / fps / 2),
      { property: existing[0].property, time: local, value },
    ];
  }
  return animated
    ? { transform, keyframes: [...keyframes].sort((a, b) => a.time - b.time) }
    : { transform };
}

/** The share of a media waveform that a clip actually plays, as peak indices. */
export function waveformRange(clip: Clip, mediaDuration: number, peaks: number): [number, number] {
  // Stored peaks cover the whole source file (media.rs).
  const covered = mediaDuration > 0 ? mediaDuration : clip.sourceIn + clip.duration * clip.speed;
  const from = Math.max(0, Math.min(peaks, Math.floor((clip.sourceIn / covered) * peaks)));
  const to = Math.max(from, Math.min(peaks, Math.ceil(((clip.sourceIn + clip.duration * clip.speed) / covered) * peaks)));
  return [from, to];
}

/** At most `limit` bars, each the loudest peak of its share, so long clips stay cheap to draw. */
export function waveformBars(peaks: number[], limit = 240): number[] {
  if (peaks.length <= limit) return peaks;
  return Array.from({ length: limit }, (_, index) =>
    Math.max(...peaks.slice(Math.floor((index * peaks.length) / limit), Math.floor(((index + 1) * peaks.length) / limit))));
}
