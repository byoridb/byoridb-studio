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
 * A canvas move/scale/rotate edits what is on screen. An animated property is written
 * as a keyframe at the playhead (replacing one within half a frame); a static
 * property is written to the transform.
 */
export function canvasTransformPatch(
  clip: Clip,
  values: Partial<Record<"x" | "y" | "scale" | "rotation", number>>,
  time: number,
  fps: number,
): Partial<Clip> {
  const local = Math.max(0, Math.min(clip.duration, time - clip.start));
  const transform = { ...clip.transform };
  let keyframes = clip.keyframes || [];
  let animated = false;
  for (const [property, value] of Object.entries(values) as ["x" | "y" | "scale" | "rotation", number][]) {
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

export interface ClipJunction {
  /** The earlier clip and the one that follows (or overlaps) it on the same track. */
  before: Clip;
  after: Clip;
}

/** Neighbouring clips of one track that touch or overlap: where a transition can sit. */
export function clipJunctions(clips: Clip[], fps: number): ClipJunction[] {
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const junctions: ClipJunction[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const before = ordered[index - 1], after = ordered[index];
    if (after.start <= before.start + before.duration + 0.5 / Math.max(1, fps) && after.start > before.start)
      junctions.push({ before, after });
  }
  return junctions;
}

/**
 * The longest transition a junction can hold: half of the shorter clip, so the
 * transitions at both ends of one clip never meet. The Library and Inspector
 * (clipPresets) build their batches from junctionTransitionCommands, so share it.
 */
export const maxTransitionDuration = (junction: ClipJunction, _fps?: number) =>
  Math.min(junction.before.duration, junction.after.duration) / 2;

/** edit.batch accepts at most this many commands (editor.rs). */
export const BATCH_LIMIT = 500;

/** Why a junction's transition cannot be edited as one batch, or null when it can. */
export function junctionTransitionBlocked(project: Project, junction: ClipJunction): string | null {
  const { before, after } = junction;
  let moved = 1;
  for (const clip of project.clips)
    if (clip.trackId === after.trackId && clip.id !== after.id && clip.id !== before.id && clip.start > after.start - epsilon) moved++;
  return moved > BATCH_LIMIT
    ? `이 뒤로 같은 트랙에 클립이 ${moved - 1}개 있어 한 번에 옮길 수 없습니다(최대 ${BATCH_LIMIT - 1}개). 트랙을 나누거나 뒤쪽 접점부터 전환을 넣어 주세요.`
    : null;
}

/**
 * Set, change or remove the transition between two neighbouring clips as one
 * batch: the later clip (and everything after it on the track) moves so that
 * the two clips overlap by exactly the transition duration, and the later clip
 * carries the transition as its transitionIn.
 */
export function junctionTransitionCommands(
  project: Project,
  junction: ClipJunction,
  transition: { type: string; duration: number } | null,
): ClipEditCommand[] {
  const { before, after } = junction;
  const frame = frameDuration(project);
  const duration = transition
    ? Math.max(frame, Math.min(maxTransitionDuration(junction, project.fps), Math.round(transition.duration / frame) * frame))
    : 0;
  const overlap = Math.max(0, before.start + before.duration - after.start);
  const shift = overlap - duration;
  const commands: ClipEditCommand[] = [];
  if (Math.abs(shift) > epsilon)
    for (const clip of project.clips)
      if (clip.trackId === after.trackId && clip.id !== after.id && clip.start > after.start - epsilon && clip.id !== before.id)
        commands.push({ method: "edit.update", params: { id: clip.id, patch: { start: Math.max(0, clip.start + shift) } } });
  const next = transition && duration > 0 ? { type: transition.type, duration } : null;
  const patch: Record<string, unknown> = {};
  if (Math.abs(shift) > epsilon) patch.start = Math.max(0, after.start + shift);
  const current = after.transitionIn ?? null;
  if ((current?.type ?? null) !== (next?.type ?? null) || Math.abs((current?.duration ?? 0) - (next?.duration ?? 0)) > epsilon)
    patch.transitionIn = next;
  if (Object.keys(patch).length) commands.unshift({ method: "edit.update", params: { id: after.id, patch } });
  return commands;
}
