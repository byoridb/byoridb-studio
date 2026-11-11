import { useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, rpc } from "./api";
import { durationOf, type Project } from "./types";

type Frame = { url: string; key: string };
type Request = {
  key: string;
  projectId: string;
  revision: number;
  time: number;
  width: number;
  valid: () => boolean;
};

/** Only one request is in flight; scrubbing replaces, rather than accumulates, work. */
export function usePreviewFrame(
  project: Project,
  time: number,
  width: number,
  enabled: boolean,
) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [attempt, setAttempt] = useState(0);
  const content = useMemo(() => JSON.stringify(project), [project]);
  const pixels = Math.max(160, Math.min(960, Math.round(width / 2) * 2));
  const at = Math.min(time, Math.max(0, durationOf(project) - 1 / project.fps));
  const key = `${content}:${Math.floor(at * project.fps)}:${pixels}`;
  const cache = useRef(new Map<string, Frame>());
  const latest = useRef<Request | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      latest.current = null;
    };
  }, []);
  useEffect(() => {
    let valid = true;
    if (!enabled) {
      latest.current = null;
      return;
    }
    const hit = cache.current.get(key);
    if (hit) {
      setFrame(hit);
      return;
    }
    const pump = async () => {
      if (running.current) return;
      running.current = true;
      try {
        while (alive.current && latest.current) {
          const request = latest.current;
          latest.current = null;
          if (!request.valid()) continue;
          try {
            const result = await rpc<{
              assetId: string;
              revision: number;
              projectId?: string;
            }>(
              "preview.frame",
              {
                time: request.time,
                width: request.width,
                expectedRevision: request.revision,
              },
              request.projectId,
            );
            if (
              result.revision !== request.revision ||
              (result.projectId && result.projectId !== request.projectId)
            )
              continue;
            const next = { url: assetUrl(result.assetId), key: request.key };
            if (cache.current.size >= 32)
              cache.current.delete(cache.current.keys().next().value!);
            cache.current.set(request.key, next);
            if (alive.current && request.valid()) setFrame(next);
          } catch {
            /* The immediate local preview remains usable on render failure. */
          }
        }
      } finally {
        running.current = false;
      }
    };
    const timer = setTimeout(() => {
      latest.current = {
        key,
        projectId: project.id,
        revision: project.revision,
        time: at,
        width: pixels,
        valid: () => valid,
      };
      void pump();
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
