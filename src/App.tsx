import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  CloudOff,
  Download,
  Film,
  FolderOpen,
  LayoutPanelLeft,
  LoaderCircle,
  Plus,
  Save,
  Settings2,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  assetUrl,
  connectStudio,
  pickFiles,
  rpc,
  uploadFile,
} from "./studio/api";
import type { Clip, Command, Job, Media, Project, RuntimeStatus } from "./studio/types";
import { durationOf } from "./studio/types";
import {
  canEditSelection,
  clipGroup,
  moveSelection,
  newClipIds,
  selectedClips,
  shiftSelectionTracks,
} from "./studio/selection";
import Player from "./studio/Player";
import { isPreviewPlaybackWaiting, primePreviewPlayback } from "./studio/mediaPlayback";
import { clipEditCommands } from "./studio/clipEditing";
import {
  PreviewDraftContext,
  withPreviewDraft,
  type PreviewDraft,
  type PreviewDraftHandler,
} from "./studio/previewDraft";
import Timeline from "./studio/Timeline";
import Library from "./studio/Library";
import Inspector from "./studio/Inspector";
import AssistantPanel from "./studio/AssistantPanel";
import Settings from "./studio/Settings";
import ExportDialog from "./studio/ExportDialog";
import { useModal } from "./studio/useModal";
import "./styles/studio.css";

/** Letter shortcuts follow the physical key when an IME (e.g. Hangul) changes event.key. */
const shortcutKey = (event: KeyboardEvent) =>
  /^[a-z]$/i.test(event.key)
    ? event.key.toLowerCase()
    : /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : event.key.toLowerCase();
const missingKey = (project: Project | null) =>
  project?.media.filter((media) => media.missing).map((media) => media.id).join() ?? "";
interface Selection {
  projectId: string | null;
  ids: string[];
  primary: string | null;
  trackId: string | null;
}
const noSelection: Selection = { projectId: null, ids: [], primary: null, trackId: null };
const noIds: string[] = [];

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Selection belongs to one project and is validated while rendering, so a
  // project change can never race a selection made in the same tick.
  const [selection, setSelection] = useState<Selection>(noSelection);
  const selectedIds = useMemo(() => {
    if (!project || selection.projectId !== project.id) return noIds;
    const valid = selection.ids.filter((id) =>
      project.clips.some((clip) => clip.id === id),
    );
    return valid.length === selection.ids.length ? selection.ids : valid;
  }, [project, selection]);
  const selectedId =
    selection.primary && selectedIds.includes(selection.primary)
      ? selection.primary
      : null;
  const selectedTrackId =
    project &&
    selection.projectId === project.id &&
    project.tracks.some((track) => track.id === selection.trackId)
      ? selection.trackId
      : null;
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);
  const clipboard = useRef<{ projectId: string; clips: Clip[] } | null>(null);
  const [time, setTime] = useState(0);
  const [seekEpoch, setSeekEpoch] = useState(0);
  const seekTime = useCallback((value: number | ((current: number) => number)) => {
    setSeekEpoch((epoch) => epoch + 1);
    setTime(value);
  }, []);
  const [playing, setPlaying] = useState(false);
  const [previewMode, setPreviewMode] = useState<"fast" | "precise">("fast");
  const [previewDraft, setPreviewDraft] = useState<PreviewDraft | null>(null);
  const preview: PreviewDraftHandler = useCallback((clipId, patch) => {
    setPreviewDraft(patch ? { clipId, patch } : null);
  }, []);
  useEffect(
    () => setPreviewDraft(null),
    [project?.id, project?.revision, selectedId],
  );
  const [assistant, setAssistant] = useState(false);
  const [settings, setSettings] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [recent, setRecent] = useState<
    { id: string; name: string; updatedAt: string | number }[] | null
  >(null);
  const [busy, setBusy] = useState("");
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const editingSurface = useRef<HTMLDivElement>(null);
  const [timelineHeight, setTimelineHeight] = useState(300);
  const [surfaceHeight, setSurfaceHeight] = useState(640);
  const maxTimelineHeight = Math.max(200, surfaceHeight - 248);
  const resizeTimeline = (height: number) =>
    setTimelineHeight(Math.max(200, Math.min(maxTimelineHeight, height)));
  useEffect(() => {
    const surface = editingSurface.current;
    if (!surface) return;
    const measure = () => {
      const height = surface.getBoundingClientRect().height;
      if (!height) return;
      setSurfaceHeight(height);
      setTimelineHeight((value) =>
        Math.max(200, Math.min(height - 248, value)),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    measure();
    return () => observer.disconnect();
  }, [!!project]);
  const current = useRef<Project | null>(null);
  current.current = project;
  const projectGeneration = useRef(0);
  const selectMany = useCallback((ids: string[], primary?: string | null) => {
    const active = current.current;
    const valid = [...new Set(ids)].filter((id) =>
      active?.clips.some((clip) => clip.id === id),
    );
    const primaryClip = active?.clips.find((clip) => clip.id === (primary || valid[valid.length - 1]));
    setSelection((previous) => ({
      projectId: active?.id ?? null,
      ids: valid,
      primary:
        primary && valid.includes(primary)
          ? primary
          : valid[valid.length - 1] || null,
      trackId: primaryClip
        ? primaryClip.trackId
        : previous.projectId === active?.id
          ? previous.trackId
          : null,
    }));
  }, []);
  const selectTrack = useCallback((trackId: string) => {
    const projectId = current.current?.id ?? null;
    setSelection((previous) => ({
      ...(previous.projectId === projectId ? previous : noSelection),
      projectId,
      trackId,
    }));
  }, []);
  const selectClip = useCallback(
    (id: string | null) => {
      selectMany(
        id && current.current ? clipGroup(current.current, id) : [],
        id,
      );
    },
    [selectMany],
  );
  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await connectStudio();
      setConnected(true);
      setOffline(false);
      setProject(await rpc<Project>("project.get"));
      void rpc<{ notice?: string | null }>("project.notice")
        .then((result) => setServiceNotice(result?.notice || null))
        .catch(() => {});
      void rpc<RuntimeStatus>("runtime.status")
        .then(setRuntime)
        .catch(() => {});
      setHistory(await rpc("history.status"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    if (!connected) return;
    // One poll per project generation at a time; an unchanged project costs
    // a few bytes instead of the whole document and never re-renders.
    let inFlight = -1;
    let failures = 0;
    // A missing-file flag changes without a revision bump, and another
    // project.get caller may have consumed the change first: compare the
    // reported set, or re-read in full now and then when none is reported.
    let full = false;
    let unchangedReplies = 0;
    const timer = setInterval(() => {
      const generation = projectGeneration.current;
      if (inFlight === generation) return;
      inFlight = generation;
      const known = current.current;
      const conditional = known && !full;
      full = false;
      void rpc<Project | { unchanged: true; missing?: string[] }>(
        "project.get",
        conditional ? { ifProjectId: known.id, ifRevision: known.revision } : {},
      )
        .then((p) => {
          failures = 0;
          setOffline(false);
          if (projectGeneration.current !== generation) return;
          if ("unchanged" in p) {
            full = p.missing
              ? p.missing.join() !== missingKey(current.current)
              : ++unchangedReplies >= 5;
            if (full) unchangedReplies = 0;
            return;
          }
          if (
            p.id !== current.current?.id ||
            p.revision > (current.current?.revision ?? -1) ||
            (p.revision === current.current.revision &&
              missingKey(p) !== missingKey(current.current))
          ) {
            if (p.id !== current.current?.id) projectGeneration.current++;
            current.current = p;
            setProject(p);
            const accepted = projectGeneration.current;
            void rpc<{ canUndo: boolean; canRedo: boolean }>(
              "history.status",
              {},
              p.id,
            )
              .then((h) => {
                if (projectGeneration.current === accepted) setHistory(h);
              })
              .catch(() => {});
          }
        })
        .catch(() => {
          if (++failures >= 2) setOffline(true);
        })
        .finally(() => {
          if (inFlight === generation) inFlight = -1;
        });
    }, 1200);
    return () => clearInterval(timer);
  }, [connected]);
  const command: Command = useCallback(async (method, params = {}) => {
    setError("");
    const switching = ["project.new", "project.open", "project.demo"].includes(
      method,
    );
    let generation = switching
      ? ++projectGeneration.current
      : projectGeneration.current;
    const projectId = switching ? undefined : current.current?.id;
    setPending((count) => count + 1);
    try {
      const guarded =
        (method.startsWith("edit.") || method === "project.update") &&
        params.expectedRevision === undefined
          ? { ...params, expectedRevision: current.current?.revision }
          : params;
      const result = await rpc<unknown>(method, guarded, projectId);
      setOffline(false);
      setSaveFailed(false);
      if (projectGeneration.current !== generation) return result;
      if (switching) generation = ++projectGeneration.current;
      if (
        result &&
        typeof result === "object" &&
        "clips" in result &&
        "tracks" in result
      ) {
        if (
          (result as Project).id === current.current?.id &&
          (result as Project).revision < current.current.revision
        )
          return result;
        current.current = result as Project;
        setProject(result as Project);
        setTime((t) => Math.min(t, durationOf(result as Project)));
      } else if (result && typeof result === "object" && "project" in result) {
        current.current = (result as { project: Project }).project;
        setProject(current.current);
      }
      const h = await rpc<{ canUndo: boolean; canRedo: boolean }>(
        "history.status",
        {},
        current.current?.id,
      );
      if (projectGeneration.current === generation) setHistory(h);
      return result;
    } catch (e) {
      // fetch rejects with a TypeError only when the service is unreachable.
      if (e instanceof TypeError) setOffline(true);
      if (method === "project.save") setSaveFailed(true);
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setPending((count) => count - 1);
    }
  }, []);
  const safeCommand: Command = useCallback(
    (method, params) => command(method, params).catch(() => undefined),
    [command],
  );
  const total = project ? durationOf(project) : 0;
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const previewRun = useRef(0);
  const previewJob = useRef<string | null>(null);
  useEffect(() => {
    setPlaying(false);
    setPlaybackUrl(null);
    setPreparing(false);
    if (previewJob.current) setBusy("");
    previewRun.current++;
    if (previewJob.current)
      void rpc("export.cancel", { id: previewJob.current }).catch(() => {});
    previewJob.current = null;
  }, [project?.id, project?.revision]);
  const requestPlayback = useCallback(
    async (next: boolean) => {
      if (!next) {
        previewRun.current++;
        setPlaying(false);
        setPreparing(false);
        setBusy("");
        if (previewJob.current)
          void rpc("export.cancel", { id: previewJob.current }).catch(() => {});
        previewJob.current = null;
        return;
      }
      if (previewMode === "fast") {
        primePreviewPlayback();
        setPlaying(true);
        return;
      }
      if (playbackUrl) {
        primePreviewPlayback();
        setPlaying(true);
        return;
      }
      const nonce = ++previewRun.current;
      setPreparing(true);
      setError("");
      setBusy("정밀 미리보기를 준비하고 있습니다");
      try {
        const result = await rpc<{ id: string; assetId: string }>(
          "preview.start",
          { width: 960 },
          current.current?.id,
        );
        if (previewRun.current !== nonce) {
          void rpc("export.cancel", { id: result.id }).catch(() => {});
          return;
        }
        previewJob.current = result.id;
        while (previewRun.current === nonce) {
          const status = await rpc<Job>("export.status", { id: result.id });
          if (previewRun.current !== nonce) break;
          if (status.state === "failed")
            throw new Error(status.error || "미리보기 렌더 실패");
          if (status.state === "cancelled") break;
          if (status.state === "completed") {
            setPlaybackUrl(assetUrl(result.assetId));
            setPlaying(true);
            break;
          }
          setBusy(
            `정밀 미리보기 준비 · ${Math.round((status.progress || 0) * 100)}%`,
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch (e) {
        if (previewRun.current === nonce)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (previewRun.current === nonce) {
          setPreparing(false);
          setBusy("");
          previewJob.current = null;
        }
      }
    },
    [playbackUrl, previewMode],
  );
  useEffect(() => {
    if (!playing) return;
    if (time >= total) seekTime(0);
    let id = 0,
      last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (isPreviewPlaybackWaiting()) {
        id = requestAnimationFrame(tick);
        return;
      }
      setTime((v) => {
        if (v + dt >= total) {
          setPlaying(false);
          return total;
        }
        return v + dt;
      });
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, total, seekTime]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(t);
  }, [notice]);
  const save = useCallback(async () => {
    try {
      const result = (await command("project.save")) as { path: string };
      setNotice(`저장됨 · ${result.path}`);
    } catch {
      /* shown inline */
    }
  }, [command]);
  // The listener is registered once and reads the latest render through a ref,
  // so a key pressed right after a state change never sees stale values.
  const live = useRef({ selectedIds, time, total, playing, preparing, settings, exportOpen, recent, requestPlayback, save });
  live.current = { selectedIds, time, total, playing, preparing, settings, exportOpen, recent, requestPlayback, save };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const { selectedIds, time, total, playing, preparing, settings, exportOpen, recent, requestPlayback, save } = live.current;
      if (recent) return; // The dialog handles its own keys (useModal).
      if (
        (event.target instanceof Element &&
          event.target.closest(
            'input,textarea,select,[contenteditable="true"]',
          )) ||
        settings ||
        exportOpen
      )
        return;
      const cmd = event.metaKey || event.ctrlKey;
      const key = shortcutKey(event);
      const active = current.current;
      if (!active) return;
      const editable = canEditSelection(active, selectedIds);
      if (event.code === "Space") {
        event.preventDefault();
        if (total) void requestPlayback(!playing && !preparing);
      } else if (cmd && key === "a") {
        event.preventDefault();
        selectMany(
          active.clips
            .filter(
              (clip) =>
                !active.tracks.find((track) => track.id === clip.trackId)
                  ?.locked,
            )
            .map((clip) => clip.id),
        );
      } else if (cmd && key === "z") {
        event.preventDefault();
        void safeCommand(event.shiftKey ? "history.redo" : "history.undo");
      } else if (cmd && key === "s") {
        event.preventDefault();
        void save();
      } else if (
        selectedIds.length && !event.altKey &&
        ((cmd && key === "b") || (!cmd && !event.shiftKey && (key === "q" || key === "w")))
      ) {
        event.preventDefault();
        if (event.repeat || event.isComposing) return;
        const action = cmd ? "split" : key === "q" ? "trim-start" : "trim-end";
        const commands = clipEditCommands(active, selectedIds, time, action);
        if (!commands.length) return;
        const result = commands.length === 1
          ? safeCommand(commands[0].method, { ...commands[0].params, expectedRevision: active.revision })
          : safeCommand("edit.batch", { commands, expectedRevision: active.revision });
        void result.then((updated) => {
          if (action === "split") {
            const ids = newClipIds(active, updated);
            if (ids.length) selectMany(ids, ids[ids.length - 1]);
          }
        });
      } else if (cmd && key === "d" && selectedIds.length) {
        event.preventDefault();
        if (editable)
          void safeCommand("edit.duplicate", { ids: selectedIds }).then(
            (result) => {
              const ids = newClipIds(active, result);
              if (ids.length) selectMany(ids);
            },
          );
      } else if (
        cmd && !event.shiftKey && !event.altKey && (key === "c" || key === "x") &&
        selectedIds.length && !window.getSelection()?.toString()
      ) {
        event.preventDefault();
        if (key === "x" && !editable) return;
        const clips = structuredClone(selectedClips(active, selectedIds));
        clipboard.current = { projectId: active.id, clips };
        if (key === "c") setNotice(`클립 ${clips.length}개를 복사했습니다 · ⌘V로 재생 헤드에 붙여넣기`);
        else
          void safeCommand("edit.delete", {
            ids: selectedIds,
            expectedRevision: active.revision,
          }).then((result) => {
            if (result) selectMany([], null);
          });
      } else if (cmd && !event.shiftKey && !event.altKey && key === "v" && clipboard.current?.projectId === active.id) {
        event.preventDefault();
        if (event.repeat) return;
        void safeCommand("edit.paste", {
          clips: clipboard.current.clips,
          at: time,
          expectedRevision: active.revision,
        }).then((result) => {
          const ids = newClipIds(active, result);
          if (ids.length) selectMany(ids);
        });
      } else if (cmd && key === "g" && selectedIds.length) {
        event.preventDefault();
        if (editable && (event.shiftKey || selectedIds.length > 1))
          void safeCommand(event.shiftKey ? "edit.ungroup" : "edit.group", {
            ids: selectedIds,
          });
      } else if (
        (event.key === "Backspace" || event.key === "Delete") &&
        selectedIds.length
      ) {
        event.preventDefault();
        if (editable)
          void safeCommand("edit.delete", {
            ids: selectedIds,
            ripple: event.shiftKey,
          }).then((result) => {
            if (result) selectMany([], null);
          });
      } else if (
        event.altKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        if (!editable) return;
        const direction =
          event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const commands =
          event.key === "ArrowLeft" || event.key === "ArrowRight"
            ? moveSelection(
                selectedClips(active, selectedIds),
                (direction * (event.shiftKey ? 10 : 1)) / active.fps,
              )
            : shiftSelectionTracks(active, selectedIds, direction);
        if (commands.length)
          void safeCommand("edit.batch", {
            commands,
            expectedRevision: active.revision,
          });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTime((value) =>
          Math.max(0, value - (event.shiftKey ? 1 : 1 / active.fps)),
        );
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTime((value) =>
          Math.min(total, value + (event.shiftKey ? 1 : 1 / active.fps)),
        );
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const edges = [
          0,
          total,
          ...active.clips.flatMap((clip) => [
            clip.start,
            clip.start + clip.duration,
          ]),
        ].sort((a, b) => a - b);
        seekTime((value) =>
          event.key === "ArrowUp"
            ? ([...edges].reverse().find((edge) => edge < value - 0.001) ?? 0)
            : (edges.find((edge) => edge > value + 0.001) ?? total),
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        seekTime(0);
      } else if (event.key === "End") {
        event.preventDefault();
        seekTime(total);
      } else if (key === "m" && !cmd && !event.altKey)
        void safeCommand("edit.marker", { time, label: "마커" });
      else if (event.key === "Escape") {
        setMenu(false);
        selectMany([], null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [safeCommand, selectMany, seekTime]);
  const relink = async (media: Media) => {
    try {
      const paths = await pickFiles();
      if (paths === null) {
        setError("원본 다시 연결은 데스크톱 앱에서 할 수 있습니다.");
        return;
      }
      if (paths.length)
        await safeCommand("media.relink", {
          id: media.id,
          path: paths[0],
          expectedRevision: current.current?.revision,
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const importPaths = async () => {
    try {
      const paths = await pickFiles();
      if (paths === null) {
        files.current?.click();
        return;
      }
      if (!paths.length) return;
      setBusy("미디어를 가져오고 있습니다");
      await command("media.import", { paths });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const importBrowser = async (list: FileList | File[]) => {
    setBusy("미디어를 분석하고 있습니다");
    setError("");
    try {
      const projectId = current.current?.id;
      if (!projectId) return;
      for (const file of Array.from(list)) {
        const updated = await uploadFile(file, projectId);
        if (current.current?.id !== projectId) break;
        if (updated.revision >= (current.current?.revision ?? 0)) {
          current.current = updated;
          setProject(updated);
        }
        const h = await rpc<{ canUndo: boolean; canRedo: boolean }>(
          "history.status",
          {},
          projectId,
        );
        if (current.current?.id === projectId) setHistory(h);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      if (files.current) files.current.value = "";
    }
  };
  const example = async () => {
    setBusy("예제 프로젝트를 준비하고 있습니다");
    try {
      await command("project.demo");
      setTime(0);
      selectMany([], null);
      setNotice(
        "예제 프로젝트 · 제공된 사진과 합성 오디오로 구성되어 있습니다.",
      );
    } catch {
      /* shown inline */
    } finally {
      setBusy("");
    }
  };
  const create = async () => {
    await safeCommand("project.new", {
      name: "이름 없는 프로젝트",
      width: 1920,
      height: 1080,
      fps: 30,
    });
    setTime(0);
    selectMany([], null);
    setMenu(false);
  };
  if (!project)
    return (
      <main className="connection-screen">
        <div className="byori-mark">b</div>
        <h1>Byori Studio</h1>
        <p>
          {loading
            ? "편집 작업 공간을 준비하고 있습니다."
            : "편집 서비스에 연결해 주세요."}
        </p>
        {loading ? (
          <LoaderCircle className="spin" size={24} />
        ) : (
          <>
            <div className="inline-error">{error}</div>
            <code>npm run studio</code>
            <button
              className="primary-button"
              onClick={() => void initialize()}
            >
              다시 연결
            </button>
          </>
        )}
      </main>
    );
  const selected = project.clips.find((c) => c.id === selectedId) || null;
  const missing = project.media.filter((media) => media.missing);
  const saveState = pending
    ? { label: "저장 중", title: "변경 사항을 저장하고 있습니다", icon: <LoaderCircle className="spin" size={11} /> }
    : offline
      ? { label: "연결 끊김", title: "편집 서비스에 연결할 수 없습니다. 변경 사항이 저장되지 않습니다.", icon: <CloudOff size={11} /> }
      : saveFailed
        ? { label: "저장 오류", title: "프로젝트를 저장하지 못했습니다. 다시 저장해 주세요.", icon: <TriangleAlert size={11} /> }
        : { label: "저장됨", title: "자동 저장", icon: <Check size={11} /> };
  return (
    <PreviewDraftContext.Provider value={preview}>
      <main
        className={`studio-app ${assistant ? "assistant-open" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            void importBrowser(e.dataTransfer.files);
          }
        }}
      >
        <input
          ref={files}
          hidden
          type="file"
          accept="video/*,audio/*,image/*,.srt,.vtt"
          multiple
          onChange={(e) => {
            if (e.target.files) void importBrowser(e.target.files);
          }}
        />
        <header className="studio-topbar">
          <div className="studio-identity">
            <span className="byori-mark">b</span>
            <strong>
              Byori <span>Studio</span>
            </strong>
            <div className="menu-container">
              <button className="menu-toggle" onClick={() => setMenu(!menu)}>
                메뉴 <ChevronDown size={13} />
              </button>
              {menu && (
                <div className="app-menu">
                  <button onClick={() => void create()}>
                    <Plus size={15} /> 새 프로젝트
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      void rpc<typeof recent>("project.list")
                        .then(setRecent)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    <FolderOpen size={15} /> 프로젝트 열기
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      void save();
                    }}
                  >
                    <Save size={15} /> 저장 <kbd>⌘S</kbd>
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      void example();
                    }}
                  >
                    <Film size={15} /> 예제 프로젝트 열기
                  </button>
                  <hr />
                  <button
                    onClick={() => {
                      setMenu(false);
                      setSettings(true);
                    }}
                  >
                    <Settings2 size={15} /> 설정
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="project-title">
            <input
              aria-label="프로젝트 이름"
              key={`${project.id}:${project.name}`}
              defaultValue={project.name}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== project.name)
                  void safeCommand("project.update", {
                    patch: { name: e.target.value.trim() },
                  });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <span
              className={offline || saveFailed ? "save-error" : ""}
              title={saveState.title}
              role="status"
            >
              {saveState.icon} {saveState.label}
            </span>
          </div>
          <div className="topbar-actions">
            <button
              className={`assistant-toggle ${assistant ? "active" : ""}`}
              onClick={() => setAssistant(!assistant)}
            >
              <Sparkles size={15} /> 어시스턴트
            </button>
            <button
              className="icon-button"
              title="설정"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="export-button"
              disabled={!project.clips.length}
              onClick={() => {
                setPlaying(false);
                setExportOpen(true);
              }}
            >
              <Download size={15} /> 내보내기
            </button>
          </div>
        </header>
        {(error || notice || busy) && (
          <div
            className={`studio-notification ${error ? "error" : ""}`}
            role={error ? "alert" : "status"}
          >
            {error ? (
              <TriangleAlert size={14} />
            ) : busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            <span>{error || busy || notice}</span>
            {(!busy || error) && (
              <button
                title="알림 닫기"
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
        {serviceNotice && (
          <div className="studio-banner" role="alert">
            <TriangleAlert size={14} />
            <span>{serviceNotice}</span>
            <button
              onClick={() => {
                setServiceNotice(null);
                void rpc("project.noticeDismiss").catch(() => {});
              }}
            >
              확인
            </button>
          </div>
        )}
        {missing.length > 0 && (
          <div className="studio-banner" role="alert">
            <TriangleAlert size={14} />
            <span>
              원본 파일을 찾을 수 없습니다 · {missing[0].name}
              {missing.length > 1 && ` 외 ${missing.length - 1}개`}
            </span>
            <button onClick={() => void relink(missing[0])}>다시 연결</button>
          </div>
        )}
        <div className="editor-workspace">
          <div
            className="editing-surface"
            ref={editingSurface}
            style={{
              gridTemplateRows: `minmax(240px, 1fr) 8px ${timelineHeight}px`,
            }}
          >
            <div className="upper-workspace">
              <Library
                project={project}
                targetTrackId={selectedTrackId}
                selected={selected}
                playhead={time}
                onCommand={command}
                onImport={() => void importPaths()}
                onSelect={selectClip}
              />
              <Player
                project={withPreviewDraft(project, previewDraft)}
                draftActive={!!previewDraft}
                previewMode={previewMode}
                onPreviewMode={(mode) => {
                  void requestPlayback(false);
                  setPlaybackUrl(null);
                  setPreviewMode(mode);
                }}
                time={time}
                seekEpoch={seekEpoch}
                playing={playing}
                onTime={seekTime}
                onPlaying={(v) => void requestPlayback(v)}
                playbackUrl={playbackUrl}
                preparing={preparing}
                selectedId={selectedId}
                onSelect={selectClip}
                onCommand={safeCommand}
              />
              <Inspector
                project={project}
                selected={selected}
                onCommand={command}
                playhead={time}
              />
            </div>
            <div
              className="timeline-resizer"
              role="separator"
              aria-label="타임라인 높이 조절"
              aria-orientation="horizontal"
              aria-valuemin={200}
              aria-valuemax={Math.round(maxTimelineHeight)}
              aria-valuenow={Math.round(timelineHeight)}
              aria-valuetext={`${Math.round(timelineHeight)}픽셀`}
              title="드래그하거나 위아래 방향키로 타임라인 높이 조절"
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (
                  event.currentTarget.hasPointerCapture(event.pointerId) &&
                  editingSurface.current
                )
                  resizeTimeline(
                    editingSurface.current.getBoundingClientRect().bottom -
                      event.clientY -
                      4,
                  );
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                if (
                  !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                resizeTimeline(
                  event.key === "Home"
                    ? 200
                    : event.key === "End"
                      ? maxTimelineHeight
                      : timelineHeight + (event.key === "ArrowUp" ? 20 : -20),
                );
              }}
            >
              <span />
            </div>
            <Timeline
              selectedTrackId={selectedTrackId}
              onTrackSelect={selectTrack}
              playing={playing}
              project={project}
              time={time}
              onTime={seekTime}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onSelection={selectMany}
              onCommand={safeCommand}
              history={history}
            />
          </div>
          {assistant && (
            <AssistantPanel
              project={project}
              selected={selected}
              onCommand={command}
              onClose={() => setAssistant(false)}
              onSettings={() => setSettings(true)}
              runtime={runtime}
            />
          )}
        </div>
        <footer className="studio-statusbar">
          <div>
            <LayoutPanelLeft size={12} />
            <span>{project.media.length}개 소재</span>
            <span className="status-separator" />
            <span>
              {project.width} × {project.height} · {project.fps} fps
            </span>
          </div>
          <div>
            {!project.clips.length && (
              <button onClick={() => void example()}>
                예제 프로젝트로 둘러보기
              </button>
            )}
            <span
              className={`status-dot ${runtime?.byoridb.connected ? "online" : ""}`}
            />
            <button onClick={() => setSettings(true)}>
              ByoriDB {runtime?.byoridb.connected ? "연결됨" : "설정"}
            </button>
          </div>
        </footer>
        {settings && (
          <Settings onClose={() => setSettings(false)} onUpdate={setRuntime} />
        )}{" "}
        {exportOpen && (
          <ExportDialog
            project={project}
            onClose={() => setExportOpen(false)}
          />
        )}
        {recent && (
          <div className="modal-backdrop">
            <RecentModal onClose={() => setRecent(null)}>
              <header>
                <h2 id="recent-title">프로젝트 열기</h2>
                <button title="닫기" onClick={() => setRecent(null)}>
                  <X size={18} />
                </button>
              </header>
              <div className="recent-list">
                {recent.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      void safeCommand("project.open", { id: p.id }).then(
                        () => {
                          setRecent(null);
                          setTime(0);
                          selectMany([], null);
                        },
                      );
                    }}
                  >
                    <Film size={23} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {new Date(p.updatedAt).toLocaleString("ko-KR")}
                      </small>
                    </span>
                  </button>
                ))}
                {!recent.length && <p>저장된 프로젝트가 없습니다.</p>}
              </div>
            </RecentModal>
          </div>
        )}
      </main>
    </PreviewDraftContext.Provider>
  );
}

function RecentModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useModal<HTMLElement>(onClose);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="recent-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recent-title"
    >
      {children}
    </section>
  );
}
