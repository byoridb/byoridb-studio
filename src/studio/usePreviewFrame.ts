import { useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, rpc } from "./api";
import { durationOf, type Project } from "./types";

type Frame = { url: string; key: string };
/** Scrubbing is debounced; a newer request makes the service cancel the older render. */
export function usePreviewFrame(
  project: Project,
  time: number,
  width: number,
  enabled: boolean,
  /** Only an older request of the same client is cancelled by a newer one. */
  client = "player",
) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [attempt, setAttempt] = useState(0);
  const content = useMemo(() => JSON.stringify(project), [project]);
  const pixels = Math.max(160, Math.min(960, Math.round(width / 2) * 2));
  const at = Math.min(time, Math.max(0, durationOf(project) - 1 / project.fps));
  const key = `${content}:${Math.floor(at * project.fps)}:${pixels}`;
  const cache = useRef(new Map<string, Frame>());
  const alive = useRef(true);
  /** Frame requests the service has not answered yet. */
  const waiting = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let valid = true;
    if (!enabled) {
      // Playback has started (or the frame is no longer shown): a render still
      // running would only take the processor from the decoders. Stop it.
      if (waiting.current)
        void rpc("preview.cancel", { client }, project.id).catch(() => {});
      return;
    }
    const hit = cache.current.get(key);
    if (hit) {
      setFrame(hit);
      return;
    }
    // Sent as soon as the scrub settles: the service cancels the superseded render
    // (PREVIEW_CANCELLED), so only the newest frame is ever waited for.
    const timer = setTimeout(() => {
      const request = { key, projectId: project.id, revision: project.revision };
      waiting.current++;
      const settle = () => {
        waiting.current--;
      };
      const reply = rpc<{ assetId: string; revision: number; projectId?: string }>(
        "preview.frame",
        { time: at, width: pixels, expectedRevision: request.revision, client },
        request.projectId,
      );
      void reply.then(settle, settle);
      reply.then(
        (result) => {
          if (
            result.revision !== request.revision ||
            (result.projectId && result.projectId !== request.projectId)
          )
            return;
          const next = { url: assetUrl(result.assetId), key: request.key };
          if (cache.current.size >= 32)
            cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(request.key, next);
          if (alive.current && valid) setFrame(next);
        },
        () => {
          /* The immediate local preview remains usable on render failure or cancellation. */
        },
      );
    }, 120);
    return () => {
      valid = false;
      clearTimeout(timer);
    };
  }, [key, enabled, attempt]);
  return frame?.key === key && enabled
    ? {
        ...frame,
        retry: () => {
          cache.current.delete(key);
          setFrame(null);
          setAttempt((value) => value + 1);
        },
      }
    : null;
}
