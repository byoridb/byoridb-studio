import { useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, rpc } from "./api";
import { durationOf, type Project } from "./types";

type Frame = {
  url: string;
  key: string;
  /** How many sources the service read from a proxy for this frame. */
  proxies: number;
};
/**
 * What `preview.frame` answers. A request replaced by a newer one, stopped, or
 * overtaken by an edit is answered `{cancelled: true, reason}` with no frame;
 * older services reject it (`PREVIEW_CANCELLED`, `PREVIEW_STALE`) instead.
 */
type FrameReply = {
  assetId?: string;
  revision?: number;
  projectId?: string;
  proxies?: number;
  cancelled?: boolean;
};
/** Scrubbing is debounced; a newer request makes the service cancel the older render. */
export function usePreviewFrame(
  project: Project,
  time: number,
  width: number,
  enabled: boolean,
  /** Only an older request of the same client is cancelled by a newer one. */
  client = "player",
  /** Read the original files even where a lighter proxy exists (`proxy: false`). */
  originals = false,
) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [attempt, setAttempt] = useState(0);
  const content = useMemo(() => JSON.stringify(project), [project]);
  const pixels = Math.max(160, Math.min(960, Math.round(width / 2) * 2));
  const at = Math.min(time, Math.max(0, durationOf(project) - 1 / project.fps));
  const key = `${content}:${Math.floor(at * project.fps)}:${pixels}:${originals ? "o" : "p"}`;
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
      // running would only take the processor from the decoders. Stop it. A
      // service without `preview.cancel` answers an error, which changes nothing.
      if (waiting.current)
        void rpc("preview.cancel", { client }, project.id).catch(() => {});
      return;
    }
    const hit = cache.current.get(key);
    if (hit) {
      setFrame(hit);
      return;
    }
    // Sent as soon as the scrub settles: the service cancels the superseded render,
    // so only the newest frame is ever waited for.
    const timer = setTimeout(() => {
      const request = { key, projectId: project.id, revision: project.revision };
      waiting.current++;
      const settle = () => {
        waiting.current--;
      };
      const reply = rpc<FrameReply | null>(
        "preview.frame",
        {
          time: at,
          width: pixels,
          expectedRevision: request.revision,
          client,
          ...(originals ? { proxy: false } : {}),
        },
        request.projectId,
      );
      void reply.then(settle, settle);
      reply.then(
        (result) => {
          // Replaced by a newer request, or stopped because playback started.
          if (!result || result.cancelled || !result.assetId) return;
          if (
            result.revision !== request.revision ||
            (result.projectId && result.projectId !== request.projectId)
          )
            return;
          const next = {
            url: assetUrl(result.assetId),
            key: request.key,
            proxies: typeof result.proxies === "number" && result.proxies > 0 ? result.proxies : 0,
          };
          if (cache.current.size >= 32)
            cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(request.key, next);
          if (alive.current && valid) setFrame(next);
        },
        () => {
          /* The immediate local preview remains usable when the render fails. */
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
