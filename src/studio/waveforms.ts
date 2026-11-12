import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "./api";
import type { Media, Project } from "./types";

/** The peaks of each media item that has them, by media id. */
export type Waveforms = ReadonlyMap<string, number[]>;

/**
 * Peaks already fetched. A waveform is derived from one file: it stays the same
 * for as long as the media item names the same file and the same peaks
 * (`waveformId`, which the service derives from them), and is forgotten when the
 * service clears it (a relink or a reprobe) or names other peaks: a file replaced
 * by one as long, reprobed by this window or by an agent, is fetched again.
 */
const cache = new Map<string, number[]>();
const fetching = new Set<string>();
/** How long after a failed `media.waveform` it is asked for again. */
const RETRY_MS = 5000;
const MAX_CACHED = 400;

const scopeOf = (projectId: string, media: Media) => JSON.stringify([projectId, media.id]);
const keyOf = (projectId: string, media: Media, waveformId = media.waveformId) =>
  `${scopeOf(projectId, media)}${JSON.stringify([media.path, media.duration, media.waveformPeaks, waveformId ?? null])}`;

/** For tests: forget every fetched waveform. */
export function clearWaveforms() {
  cache.clear();
  fetching.clear();
}

/**
 * The waveforms the timeline draws. The project arrives without them
 * (`omitWaveforms`: each media item carries only `waveformPeaks`), so the peaks
 * of every media item an audio clip plays are fetched once with `media.waveform`
 * and kept. A project that still carries `waveform` (an upload's reply) is used
 * as it is.
 */
export function useWaveforms(project: Project | null): Waveforms {
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const projectId = project?.id ?? "";
  const media = project?.media;
  const clips = project?.clips;
  // Only what an audio clip plays is drawn as a waveform.
  const wanted = useMemo(() => {
    const used = new Set<string>();
    for (const clip of clips ?? []) if (clip.kind === "audio" && clip.mediaId) used.add(clip.mediaId);
    return (media ?? []).filter((item) => used.has(item.id));
  }, [media, clips]);
  const missing = wanted.filter(
    (item) => !item.waveform && (item.waveformPeaks ?? 0) > 0 && !cache.has(keyOf(projectId, item)),
  );
  const latest = useRef(missing);
  latest.current = missing;
  // Not computed (or cleared for a new file): what was fetched for it before is not it.
  const cleared = wanted
    .filter((item) => !item.waveform && item.waveformPeaks === undefined)
    .map((item) => scopeOf(projectId, item));
  const clearedScopes = useRef(cleared);
  clearedScopes.current = cleared;
  const clearedSignature = cleared.join();
  useEffect(() => {
    for (const key of [...cache.keys()])
      if (clearedScopes.current.some((scope) => key.startsWith(scope))) cache.delete(key);
  }, [clearedSignature]);
  const signature = missing.map((item) => keyOf(projectId, item)).join();
  useEffect(() => {
    if (!signature) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const redraw = () => {
      if (mounted.current) setVersion((value) => value + 1);
    };
    for (const item of latest.current) {
      const key = keyOf(projectId, item);
      if (fetching.has(key)) continue;
      fetching.add(key);
      rpc<{ id: string; waveform: number[] | null; waveformId?: string }>("media.waveform", { id: item.id }, projectId)
        .then((result) => {
          fetching.delete(key);
          // null: cleared since the project was read; the next project says so.
          if (!Array.isArray(result?.waveform)) return;
          // Only the latest peaks of a media item are kept.
          const scope = scopeOf(projectId, item);
          for (const old of [...cache.keys()]) if (old.startsWith(scope)) cache.delete(old);
          if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
          // Kept under the name the service gave these peaks. When they were computed
          // anew since the project was read, that is not the name asked for: the
          // next project carries it, and until then the clip has no bars.
          const kept = keyOf(projectId, item, result.waveformId ?? item.waveformId);
          cache.set(kept, result.waveform);
          if (kept === key) redraw();
        })
        .catch(() => {
          fetching.delete(key);
          // The clip is drawn without bars meanwhile; asked for again shortly.
          retry ??= setTimeout(redraw, RETRY_MS);
        });
    }
    return () => clearTimeout(retry);
  }, [signature, projectId, version]);
  return useMemo(() => {
    const peaks = new Map<string, number[]>();
    for (const item of wanted) {
      const known = item.waveform ?? cache.get(keyOf(projectId, item));
      if (known) peaks.set(item.id, known);
    }
    return peaks;
    // `version` changes when a fetched waveform arrives.
  }, [wanted, projectId, version]);
}
