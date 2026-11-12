import { useCallback, useEffect, useRef, useState } from "react";

const maxFailures = 5;

/**
 * Polls `task` while `key` is non-null. One request at a time; failures back
 * off exponentially and polling stops after repeated failures until `retry`.
 */
export function usePoll(
  key: string | null,
  task: () => Promise<void>,
  interval: number,
) {
  const [error, setError] = useState("");
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      latest
        .current()
        .then(() => {
          failures = 0;
          if (live) setError("");
        })
        .catch((e: unknown) => {
          failures += 1;
          if (live) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!live) return;
          if (failures < maxFailures)
            timer = setTimeout(tick, Math.min(interval * 2 ** failures, 15000));
          else setStalled(true);
        });
    };
    timer = setTimeout(tick, interval);
    return () => {
      live = false;
      clearTimeout(timer);
      setError("");
      setStalled(false);
    };
  }, [key, interval, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { error, stalled, retry };
}
