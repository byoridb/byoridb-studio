import type { Clip, Project, Track } from "./types";

export const trackKindForClip = (clip: Clip): Track["kind"] =>
  clip.kind === "text" ? "text" : clip.kind === "audio" ? "audio" : "video";

/** A layer move preserves timing and never converts a clip to a different media kind. */
export const moveSelectionToTrack = (project: Project, ids: string[], trackId: string) => {
  if (!canEditSelection(project, ids)) return [];
  const target = project.tracks.find((track) => track.id === trackId);
  const clips = selectedClips(project, ids);
  if (!target || target.locked || clips.some((clip) => trackKindForClip(clip) !== target.kind)) return [];
  return clips.filter((clip) => clip.trackId !== trackId).map((clip) => ({
    method: "edit.update",
    params: { id: clip.id, patch: { trackId } },
  }));
};

export const clipGroup = (project: Project, id: string): string[] => {
  const clip = project.clips.find((item) => item.id === id);
  if (!clip) return [];
  return typeof clip.groupId === "string"
    ? project.clips
        .filter((item) => item.groupId === clip.groupId)
        .map((item) => item.id)
    : [id];
};

export const toggleSelection = (
  project: Project,
  selected: string[],
  id: string,
): string[] => {
  const group = clipGroup(project, id);
  return group.every((item) => selected.includes(item))
    ? selected.filter((item) => !group.includes(item))
    : [...new Set([...selected, ...group])];
};

export const selectedClips = (project: Project, ids: string[]) =>
  project.clips.filter((clip) => ids.includes(clip.id));
export const canEditSelection = (project: Project, ids: string[]) =>
  ids.length > 0 &&
  ids.every((id) => {
    const clip = project.clips.find((item) => item.id === id);
    return (
      clip && !project.tracks.find((track) => track.id === clip.trackId)?.locked
    );
  });

export const moveSelection = (clips: Clip[], delta: number) => {
  const offset = Math.max(delta, -Math.min(...clips.map((clip) => clip.start)));
  return clips.map((clip) => ({
    method: "edit.update",
    params: { id: clip.id, patch: { start: clip.start + offset } },
  }));
};

/** Shift each clip to a neighbouring track of the same kind, or move none. */
export const shiftSelectionTracks = (
  project: Project,
  ids: string[],
  direction: number,
) => {
  if (!canEditSelection(project, ids)) return [];
  const commands = [];
  for (const clip of selectedClips(project, ids)) {
    const source = project.tracks.find((track) => track.id === clip.trackId);
    if (!source) return [];
    const compatible = project.tracks.filter(
      (track) => track.kind === source.kind,
    );
    const destination =
      compatible[
        compatible.findIndex((track) => track.id === source.id) + direction
      ];
    if (!destination || destination.locked) return [];
    commands.push({
      method: "edit.update",
      params: { id: clip.id, patch: { trackId: destination.id } },
    });
  }
  return commands;
};

export const newClipIds = (before: Project, result: unknown): string[] => {
  if (
    !result ||
    typeof result !== "object" ||
    !("clips" in result) ||
    !Array.isArray(result.clips)
  )
    return [];
  const previous = new Set(before.clips.map((clip) => clip.id));
  return (result.clips as Clip[])
    .filter((clip) => !previous.has(clip.id))
    .map((clip) => clip.id);
};
