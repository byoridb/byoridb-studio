import { createContext, useContext } from "react";
import type { Project } from "./types";

export type PreviewDraft = { clipId: string; patch: Record<string, unknown> };
export type PreviewDraftHandler = (
  clipId: string,
  patch: Record<string, unknown> | null,
) => void;
export const PreviewDraftContext = createContext<PreviewDraftHandler>(() => {});
export const usePreviewDraft = () => useContext(PreviewDraftContext);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Mirror the editor's object merge; arrays and scalar values replace the old value. */
function mergePreviewValue(target: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) {
    return patch.map((value) => mergePreviewValue(undefined, value));
  }
  if (!isObject(patch)) return patch;
  const result: Record<string, unknown> = {};
  if (isObject(target)) {
    for (const [key, value] of Object.entries(target)) {
      if (!unsafeKeys.has(key)) result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!unsafeKeys.has(key)) {
      result[key] = mergePreviewValue(result[key], value);
    }
  }
  return result;
}

/** Transient visual state only. Never pass this project to persistence or export. */
export function withPreviewDraft(
  project: Project,
  draft: PreviewDraft | null,
): Project {
  if (!draft) return project;
  return {
    ...project,
    clips: project.clips.map((clip) =>
      clip.id === draft.clipId
        ? (mergePreviewValue(clip, draft.patch) as typeof clip)
        : clip,
    ),
  };
}
