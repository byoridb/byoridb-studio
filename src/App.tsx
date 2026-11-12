import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  CloudOff,
  Download,
  Ellipsis,
  Film,
  FolderOpen,
  LoaderCircle,
  Plus,
  Settings2,
  SlidersHorizontal,
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
import type { Clip, Command, CommandBuilder, EditCommand, Job, Media, Project, RuntimeStatus } from "./studio/types";
import { durationOf } from "./studio/types";
import {
  canEditSelection,
  clipGroup,
  moveSelection,
  newClipIds,
  selectedClips,
  shiftSelectionTracks,
} from "./studio/selection";
import Player, { type LoopRange } from "./studio/Player";
import Home, { DEFAULT_PROJECT_NAME, EXAMPLE_PROJECT_NAME, UNNAMED, type ProjectSummary } from "./studio/Home";
import { playbackClock, runPlayback, useIdleClockTime } from "./studio/playbackClock";
import { useWaveforms } from "./studio/waveforms";
import { isPreviewPlaybackWaiting, primePreviewPlayback } from "./studio/mediaPlayback";
import { clipEditCommands, overlayPlacement, presentIds as present } from "./studio/clipEditing";
import { useCoveredInert } from "./studio/coveredInert";
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
import { errorText } from "./studio/errorText";
import "./styles/studio.css";

/** Letter shortcuts follow the physical key when an IME (e.g. Hangul) changes event.key. */
const shortcutKey = (event: KeyboardEvent) =>
  /^[a-z]$/i.test(event.key)
    ? event.key.toLowerCase()
    : /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : event.key.toLowerCase();
const flaggedKey = (project: Project | null, flag: "missing" | "proxy") =>
  project?.media.filter((media) => media[flag]).map((media) => media.id).join() ?? "";
/** What the service fills in without a new revision: missing files, proxies, waveforms. */
const derivedKey = (project: Project | null) =>
  project?.media
    .map((media) => `${media.id}:${media.missing ? 1 : 0}${media.proxy ? 1 : 0}:${media.waveform?.length ?? media.waveformPeaks ?? "-"}${media.waveformId ?? ""}`)
    .join() ?? "";
interface Selection {
  projectId: string | null;
  ids: string[];
  primary: string | null;
  trackId: string | null;
}
const noSelection: Selection = { projectId: null, ids: [], primary: null, trackId: null };
const noIds: string[] = [];
/** A project nobody has worked on yet: the app opens on the home screen instead. */
const isBlank = (project: Project) =>
  !project.clips.length &&
  !project.media.length &&
  UNNAMED.includes(project.name);

interface Layout {
  /** Panel widths in pixels; a null library keeps its responsive default. */
  library: number | null;
  inspector: number;
  timeline: number;
}
const LAYOUT_KEY = "byori.layout";
const defaultLayout: Layout = { library: null, inspector: 278, timeline: 300 };
const storedLayout = (): Layout => {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") as Partial<Layout>;
    const size = (input: unknown) =>
      typeof input === "number" && Number.isFinite(input) && input > 0 ? input : null;
    return {
      library: size(value.library),
      inspector: size(value.inspector) ?? defaultLayout.inspector,
      timeline: size(value.timeline) ?? defaultLayout.timeline,
    };
  } catch {
    return defaultLayout;
  }
};
/**
 * The revisions this window made itself: `from → to` for every edit the service
 * accepted from it. A command built on an older revision may be sent on the newest
 * one only when every step in between is in here; a revision made by anyone else
 * (an agent, the CLI) breaks the chain, and the service then rejects the command.
 */
export class OwnRevisions {
  private projectId: string | null = null;
  private next = new Map<number, number>();
  /** The newest revision reached from `base` through this window's edits alone. */
  latest(projectId: string | undefined, base: number): number {
    if (projectId !== this.projectId) return base;
    let revision = base;
    while (this.next.has(revision)) revision = this.next.get(revision)!;
    return revision;
  }
  /** The service applied one edit of ours on `from`: every commit is exactly one revision. */
  record(projectId: string | undefined, from: number, to: number) {
    if (!projectId || to !== from + 1) return;
    if (projectId !== this.projectId) {
      this.projectId = projectId;
      this.next.clear();
    }
    this.next.set(from, to);
    if (this.next.size > 256) this.next.delete(this.next.keys().next().value!);
  }
}
/** Commands that change the project: sent one at a time, each on the revision the one before left. */
const isEdit = (method: string) =>
  method.startsWith("edit.") || method.startsWith("history.") || method === "project.update";

/** How often a precise preview render is asked for its progress (a loopback call). */
const PREVIEW_POLL_MS = 100;
const PANEL_LIMITS = { library: [220, 560], inspector: [240, 520] } as const;
/** The assistant drawer: its width and the gap beside it. */
const DRAWER_WIDTH = 320 + 6;
/** The player keeps at least this width while the assistant drawer is open. */
const PLAYER_ROOM = 420;
/**
 * The least height of the row above the timeline (library, player, inspector) and of
 * the timeline, with the 8px separator between them. With the top bar (54), the
 * workspace's bottom padding (6) and the status bar (23) the editor needs
 * 54 + 220 + 8 + 200 + 6 + 23 = 511px of page: `.studio-app` in studio.css says the same.
 */
const UPPER_MIN_HEIGHT = 220;
const TIMELINE_MIN_HEIGHT = 200;
const TIMELINE_SEPARATOR = 8;
/** Two separators and the narrowest player. */
const PLAYER_RESERVE = 6 + 250 + 6;

/**
 * What stands beside the player while the assistant drawer is open. `workspace` is
 * the width the drawer shares with the editing surface. The drawer is a column while
 * the player keeps PLAYER_ROOM beside it; when it cannot with the inspector shown,
 * the inspector folds away; when it cannot even then, the drawer floats over the
 * surface, which keeps the layout it has with the drawer closed.
 */
export function drawerLayout(
  layout: { library: number | null; inspector: number },
  workspace: number,
): { inspector: boolean; overlay: boolean } {
  if (!(workspace > 0)) return { inspector: true, overlay: false };
  const surface = workspace - DRAWER_WIDTH;
  const player = (inspectorShown: boolean) => {
    const fitted = fitPanelWidths(layout, surface, inspectorShown);
    const narrow = surface <= 1200;
    const library = fitted.library ?? Math.max(narrow ? 280 : 282, surface * (narrow ? 0.29 : 0.28));
    const inspector = fitted.inspector ?? (narrow ? 252 : defaultLayout.inspector);
    return surface - library - 6 - (inspectorShown ? 6 + inspector : 0);
  };
  if (player(true) >= PLAYER_ROOM) return { inspector: true, overlay: false };
  if (player(false) >= PLAYER_ROOM) return { inspector: false, overlay: false };
  return { inspector: true, overlay: true };
}

/**
 * The panel widths that fit a workspace `width` wide. The chosen widths stay
 * stored; they are only narrowed (never below their minimum) while the window
 * is too small for them. A null width is the stylesheet's responsive default.
 */
export function fitPanelWidths(
  layout: { library: number | null; inspector: number },
  width: number,
  /** False while the assistant drawer stands in for the inspector column. */
  inspectorShown = true,
): { library: number | null; inspector: number | null } {
  const inspector = layout.inspector === defaultLayout.inspector ? null : layout.inspector;
  if (!(width > 0)) return { library: layout.library, inspector };
  const [minLibrary] = PANEL_LIMITS.library, [minInspector] = PANEL_LIMITS.inspector;
  if (!inspectorShown) {
    // Library, one separator and the narrowest player.
    const room = width - 6 - 250;
    return {
      library: layout.library === null || layout.library <= room ? layout.library : Math.max(minLibrary, Math.floor(room)),
      inspector: null,
    };
  }
  const budget = width - PLAYER_RESERVE;
  // The responsive defaults, as the stylesheet resolves them.
  const narrow = width <= 1200;
  const library = layout.library ?? Math.max(narrow ? 280 : 282, width * (narrow ? 0.29 : 0.28));
  const side = layout.inspector === defaultLayout.inspector && narrow ? 252 : layout.inspector;
  if (library + side <= budget) return { library: layout.library, inspector };
  if (layout.library === null)
    return { library: null, inspector: inspector && Math.max(minInspector, Math.floor(budget - library)) };
  const scale = budget / (library + side);
  const fitted = Math.max(minInspector, Math.floor(side * scale));
  return {
    library: Math.max(minLibrary, Math.min(library, Math.floor(budget - fitted))),
    inspector: inspector && fitted,
  };
}

function PanelResizer({
  panel,
  label,
  value,
  onChange,
}: {
  panel: "library" | "inspector";
  label: string;
  value: number | null;
  onChange: (width: number | null) => void;
}) {
  const [min, max] = PANEL_LIMITS[panel];
  const clamp = (width: number) => Math.round(Math.max(min, Math.min(max, width)));
  // The library sits before its separator, the inspector after it.
  const target = (element: HTMLElement) =>
    (panel === "library" ? element.previousElementSibling : element.nextElementSibling)?.getBoundingClientRect();
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
      title="드래그하거나 좌우 방향키로 폭 조절 · 더블클릭으로 기본값"
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
        const rect = target(event.currentTarget);
        if (rect) onChange(clamp(panel === "library" ? event.clientX - rect.left : rect.right - event.clientX));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        const width = value || target(event.currentTarget)?.width || min;
        const grow = (event.key === "ArrowRight") === (panel === "library");
        onChange(clamp(width + (grow ? 16 : -16)));
      }}
    >
      <span />
    </div>
  );
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Selection belongs to one project and is validated while rendering, so a
  // project change can never race a selection made in the same tick.
  const [selection, showSelection] = useState<Selection>(noSelection);
  // The selection as it was last set, readable before the render that shows it:
  // a copy made right after an edit takes what that edit selected.
  const selectionNow = useRef(selection);
  const setSelection = useCallback((update: (previous: Selection) => Selection) => {
    selectionNow.current = update(selectionNow.current);
    showSelection(selectionNow.current);
  }, []);
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
  const [clipboardProject, setClipboardProject] = useState<string | null>(null);
  // The playhead lives in the playback clock, outside React: playback must not
  // re-render the app, the library or the inspector.
  // The paused playhead always sits on a whole frame, so the timecode, the precise
  // frame and anything placed "at the playhead" agree on which frame that is.
  const snapToFrame = useCallback((value: number) => {
    const fps = current.current?.fps || 30;
    return Math.round(value * fps) / fps;
  }, []);
  const seekTime = useCallback(
    (value: number | ((now: number) => number)) =>
      playbackClock.seek((now) => snapToFrame(typeof value === "function" ? value(now) : value)),
    [snapToFrame],
  );
  // Playback belongs to one project: another project is simply not playing, with
  // no effect that could run after (and undo) a click on play.
  const [playingFor, setPlayingFor] = useState<string | null>(null);
  const playing = !!project && playingFor === project.id;
  const setPlaying = useCallback(
    (value: boolean) => setPlayingFor(value ? (current.current?.id ?? null) : null),
    [],
  );
  const idleTime = useIdleClockTime(playing);
  const [loop, setLoop] = useState<LoopRange | null>(null);
  /** null until the first project arrives; then the home screen or the editor. */
  const [home, setHome] = useState<boolean | null>(null);
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
  /** Counts the settings windows closed over the home screen, whose cleanup may have removed projects. */
  const [homeReload, setHomeReload] = useState(0);
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
  const [layout, setLayout] = useState(storedLayout);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* The layout still applies for this session. */
    }
  }, [layout]);
  const [surfaceHeight, setSurfaceHeight] = useState(640);
  /** The width the editing surface and the assistant drawer share; 0 until measured. */
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const drawer = assistant ? drawerLayout(layout, workspaceWidth) : { inspector: true, overlay: false };
  const inspectorShown = drawer.inspector;
  // Derived rather than measured, so the panels fit in the same render the drawer opens in.
  const surfaceWidth = workspaceWidth > 0
    ? workspaceWidth - (assistant && !drawer.overlay ? DRAWER_WIDTH : 0)
    : 0;
  const panels = fitPanelWidths(layout, surfaceWidth, inspectorShown);
  const focusInspector = useRef(false);
  useEffect(() => {
    if (!inspectorShown || !focusInspector.current) return;
    focusInspector.current = false;
    editingSurface.current?.querySelector<HTMLElement>(".studio-inspector")?.focus();
  }, [inspectorShown]);
  // The floating drawer hides the right of the player and the timeline as well as
  // the inspector: nothing under it takes focus or a click.
  useCoveredInert(
    editingSurface,
    () => editingSurface.current?.parentElement?.querySelector<HTMLElement>(":scope > .assistant-panel"),
    assistant && drawer.overlay,
    // The surface is another element after a visit to the home screen.
    `${!!project}:${home}`,
    // An edit moves clips (and their handles) without adding or removing one.
    project ? `${project.id}:${project.revision}` : "",
  );
  // The project comes without waveforms; the timeline's are fetched once per media item.
  const waveforms = useWaveforms(project);
  const maxTimelineHeight = Math.max(TIMELINE_MIN_HEIGHT, surfaceHeight - UPPER_MIN_HEIGHT - TIMELINE_SEPARATOR);
  // The stored height is kept as chosen and only clamped to what fits right now.
  const timelineHeight = Math.max(TIMELINE_MIN_HEIGHT, Math.min(maxTimelineHeight, layout.timeline));
  const resizeTimeline = (height: number) =>
    setLayout((value) => ({ ...value, timeline: Math.round(Math.max(TIMELINE_MIN_HEIGHT, Math.min(maxTimelineHeight, height))) }));
  useEffect(() => {
    const surface = editingSurface.current;
    if (!surface) return;
    const workspace = surface.parentElement;
    const measure = () => {
      const { height } = surface.getBoundingClientRect();
      if (!height) return;
      setSurfaceHeight(height);
      // Less the workspace's 6px side padding.
      setWorkspaceWidth(Math.max(0, (workspace?.getBoundingClientRect().width ?? 0) - 12));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    if (workspace) observer.observe(workspace);
    measure();
    return () => observer.disconnect();
  }, [!!project, home]);
  const current = useRef<Project | null>(null);
  current.current = project;
  const projectGeneration = useRef(0);
  const ownRevisions = useRef(new OwnRevisions());
  const editQueue = useRef<Promise<void>>(Promise.resolve());
  const editsInFlight = useRef(0);
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
      const opened = await rpc<Project>("project.get");
      playbackClock.seek(0);
      setProject(opened);
      setHome((shown) => shown ?? isBlank(opened));
      void rpc<{ notice?: string | null }>("project.notice")
        .then((result) => setServiceNotice(result?.notice || null))
        .catch(() => {});
      void rpc<RuntimeStatus>("runtime.status")
        .then(setRuntime)
        .catch(() => {});
      setHistory(await rpc("history.status"));
    } catch (e) {
      setError(errorText(e).message);
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
      void rpc<Project | { unchanged: true; missing?: string[]; proxy?: string[] }>(
        "project.get",
        conditional ? { ifProjectId: known.id, ifRevision: known.revision } : {},
      )
        .then((p) => {
          failures = 0;
          setOffline(false);
          if (projectGeneration.current !== generation) return;
          if ("unchanged" in p) {
            full = p.missing
              ? p.missing.join() !== flaggedKey(current.current, "missing") ||
                (p.proxy ?? []).join() !== flaggedKey(current.current, "proxy")
              : ++unchangedReplies >= 5;
            if (full) unchangedReplies = 0;
            return;
          }
          if (
            p.id !== current.current?.id ||
            p.revision > (current.current?.revision ?? -1) ||
            (p.revision === current.current.revision &&
              derivedKey(p) !== derivedKey(current.current))
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
  /**
   * Runs one service command. `quiet` is for the library and the inspector, which
   * show a failure in place: the same failure is not also raised as a toast.
   */
  const run = useCallback(async (
    method: string,
    /** The parameters, or for an edit a function that makes them from the project as it is when the edit is sent. */
    given: Record<string, unknown> | CommandBuilder = {},
    quiet = false,
    /**
     * For an edit that is made from what the edits before it leave behind (their answer
     * and what they select): it takes its place in the queue now, and is made and sent
     * when its turn has come and this has settled. Edits made after it wait behind it.
     */
    ready?: Promise<unknown>,
  ) => {
    const build = typeof given === "function" ? given : null;
    // Nothing is on its way, so the project on screen is the one the command would be
    // made from: a command with nothing to do (a cut outside the clip, a clip that is
    // gone) ends here, without touching the save state or a message that is showing.
    if (build && !ready && !editsInFlight.current && !(current.current && build(current.current)))
      return undefined;
    setError("");
    const params = build ? {} : (given as Record<string, unknown>);
    const switching = ["project.new", "project.open", "project.demo"].includes(
      method,
    );
    let generation = projectGeneration.current;
    const projectId = switching ? undefined : current.current?.id;
    const edit = isEdit(method);
    // The revision the command was built on: the caller's, or what is on screen now.
    const base =
      typeof params.expectedRevision === "number"
        ? params.expectedRevision
        : edit && method !== "history.undo" && method !== "history.redo"
          ? current.current?.revision
          : undefined;
    /** Sends the command and takes the project it answers with; false when that answer is stale. */
    const send = async (): Promise<[unknown, boolean]> => {
      if (ready) await ready.catch(() => undefined);
      // From its turn on, answers for the project being left are stale. Not earlier:
      // the edits before it still follow one another's revisions.
      if (switching) generation = ++projectGeneration.current;
      // The project was left while this edit waited its turn: it is not sent to a
      // service that has another project open by now.
      if (edit && current.current?.id !== projectId) return [undefined, false];
      // Made now, from the project the edits before this one left.
      const built = build && current.current ? build(current.current) : params;
      if (!built) return [undefined, false];
      // An edit of ours that was still on its way when this one was made has moved
      // the project on: follow our own revisions, and only ours.
      const expected = build
        ? current.current?.revision
        : base === undefined ? undefined : ownRevisions.current.latest(projectId, base);
      const sentOn = expected ?? (current.current?.id === projectId ? current.current?.revision : undefined);
      const result = await rpc<unknown>(
        method,
        expected === undefined ? built : { ...built, expectedRevision: expected },
        projectId,
      );
      setOffline(false);
      setSaveFailed(false);
      if (projectGeneration.current !== generation) return [result, false];
      if (switching) generation = ++projectGeneration.current;
      if (
        result &&
        typeof result === "object" &&
        "clips" in result &&
        "tracks" in result
      ) {
        const updated = result as Project;
        if ((edit || expected !== undefined) && sentOn !== undefined && updated.id === projectId)
          ownRevisions.current.record(projectId, sentOn, updated.revision);
        if (
          updated.id === current.current?.id &&
          updated.revision < current.current.revision
        )
          return [result, false];
        current.current = updated;
        setProject(updated);
        playbackClock.set(Math.min(playbackClock.get(), durationOf(updated)));
      } else if (result && typeof result === "object" && "project" in result) {
        current.current = (result as { project: Project }).project;
        setProject(current.current);
      }
      return [result, true];
    };
    setPending((count) => count + 1);
    try {
      // Edits go out one at a time, in the order they were made: each is sent only
      // once the one before has answered, on the revision that answer left. Leaving
      // the project takes its turn too, so the edits before it reach that project
      // and none made after it does.
      let outcome: Promise<[unknown, boolean]>;
      if (edit || switching) {
        outcome = editsInFlight.current || ready ? editQueue.current.then(send) : send();
        editsInFlight.current++;
        const settled = outcome.then(() => {}, () => {});
        editQueue.current = settled;
        void settled.then(() => { editsInFlight.current--; });
      } else outcome = send();
      const [result, fresh] = await outcome;
      if (!fresh) return result;
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
      if (!quiet) setError(errorText(e).message);
      throw e;
    } finally {
      setPending((count) => count - 1);
    }
  }, []);
  /** Edits that have not finished: sent or waiting their turn, answer and history not yet taken. */
  const unsettledEdits = useRef(new Set<Promise<unknown>>());
  const execute = useCallback((
    method: string,
    given: Record<string, unknown> | CommandBuilder = {},
    quiet = false,
    ready?: Promise<unknown>,
  ) => {
    const answer = run(method, given, quiet, ready);
    if (isEdit(method)) {
      const pending = unsettledEdits.current;
      const done = () => { pending.delete(answer); };
      pending.add(answer);
      answer.then(done, done);
    }
    return answer;
  }, [run]);
  const command: EditCommand = useCallback((method, params) => execute(method, params), [execute]);
  const panelCommand: EditCommand = useCallback((method, params) => execute(method, params, true), [execute]);
  const safeCommand: EditCommand = useCallback(
    (method, params) => command(method, params).catch(() => undefined),
    [command],
  );
  /**
   * The library adds text and stickers at the playhead. One that would cover a
   * clip already on its track goes to a track that is free there, or to a new
   * track above (made by the same edit.add, so it is still one undo step).
   */
  const libraryCommand: Command = useCallback(
    async (method, params = {}) => {
      const active = current.current;
      const media = active?.media.find((item) => item.id === params.mediaId);
      // Text, or a picture placed as an overlay: the library gives a sticker a
      // transform, and one it has only just uploaded is not in this project copy yet.
      const kind = params.text
        ? "text"
        : params.mediaId && params.transform && (!media || media.kind === "image") ? "video" : null;
      if (method !== "edit.add" || !active || !kind || typeof params.start !== "number")
        return panelCommand(method, params);
      const start = Math.round(params.start * active.fps) / active.fps;
      const duration = typeof params.duration === "number" ? params.duration : 3;
      const place = overlayPlacement(active, kind, start, duration, params.trackId as string | undefined);
      if (!place) return panelCommand(method, params);
      if ("trackId" in place) return panelCommand(method, { ...params, trackId: place.trackId });
      // No free track: the core makes one above its kind for this clip, one undo step.
      const { trackId: _preferred, ...rest } = params;
      void _preferred;
      const names = { video: "영상", text: "자막·텍스트" } as const;
      return panelCommand(method, {
        ...rest,
        newTrack: `${names[kind]} ${active.tracks.filter((track) => track.kind === kind).length + 1}`,
      });
    },
    [panelCommand],
  );
  const total = project ? durationOf(project) : 0;
  // A rendered precise preview is one revision of one project; any other is not it.
  const projectKey = project ? `${project.id}:${project.revision}` : "";
  const [rendered, setRendered] = useState<{ key: string; url: string } | null>(null);
  const playbackUrl = rendered?.key === projectKey ? rendered.url : null;
  const [preparing, setPreparing] = useState(false);
  const previewRun = useRef(0);
  const previewJob = useRef<string | null>(null);
  /** The project revision a precise preview is being rendered for. */
  const preparingKey = useRef<string | null>(null);
  useEffect(() => {
    // Returning to a project later never resumes on its own.
    setPlayingFor((id) => (id === project?.id ? id : null));
    // An edit leaves fast playback running; it only retires what was rendered
    // for the previous revision.
    if (rendered && rendered.key !== projectKey) {
      setRendered(null);
      setPlaying(false);
    }
    if (preparingKey.current && preparingKey.current !== projectKey) {
      preparingKey.current = null;
      previewRun.current++;
      setPreparing(false);
      setBusy("");
      if (previewJob.current)
        void rpc("export.cancel", { id: previewJob.current }).catch(() => {});
      previewJob.current = null;
    }
  }, [projectKey]);
  const requestPlayback = useCallback(
    async (next: boolean) => {
      if (!next) {
        previewRun.current++;
        playbackClock.set(snapToFrame(playbackClock.get()));
        setPlaying(false);
        setPreparing(false);
        setBusy("");
        if (previewJob.current)
          void rpc("export.cancel", { id: previewJob.current }).catch(() => {});
        previewJob.current = null;
        preparingKey.current = null;
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
      const key = current.current ? `${current.current.id}:${current.current.revision}` : "";
      preparingKey.current = key;
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
            setRendered({ key, url: assetUrl(result.assetId) });
            setPlaying(true);
            break;
          }
          setBusy(
            `정밀 미리보기 준비 · ${Math.round((status.progress || 0) * 100)}%`,
          );
          // A finished render starts playing within this interval: keep it short.
          await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS));
        }
      } catch (e) {
        if (previewRun.current === nonce)
          setError(errorText(e).message);
      } finally {
        if (previewRun.current === nonce) {
          setPreparing(false);
          setBusy("");
          previewJob.current = null;
          preparingKey.current = null;
        }
      }
    },
    [playbackUrl, previewMode, snapToFrame, setPlaying],
  );
  useEffect(() => setLoop(null), [project?.id]);
  // The repeated range, clamped to the project; a range emptied by an edit is ignored.
  const activeLoop = useMemo(() => {
    if (!loop || !project) return null;
    const range = { start: Math.max(0, loop.start), end: Math.min(loop.end, total) };
    return range.end - range.start >= 1 / project.fps ? range : null;
  }, [loop, total, project?.fps]);
  /** The span of the selected clips: what the repeat button repeats. */
  const selectionRange = useMemo(() => {
    const clips = project ? selectedClips(project, selectedIds) : [];
    if (!clips.length) return null;
    return {
      start: Math.min(...clips.map((clip) => clip.start)),
      end: Math.max(...clips.map((clip) => clip.start + clip.duration)),
    };
  }, [project, selectedIds]);
  const loopRef = useRef(activeLoop);
  loopRef.current = activeLoop;
  useEffect(() => {
    if (!playing) return;
    const range = loopRef.current;
    const at = playbackClock.get();
    if (range ? at < range.start || at >= range.end : at >= total)
      playbackClock.seek(range?.start ?? 0);
    // Timed by the wall clock, so it goes on (and ends, and repeats) in a hidden window too.
    return runPlayback({
      total,
      loop: () => loopRef.current,
      waiting: isPreviewPlaybackWaiting,
      onEnd: () => setPlaying(false),
    });
  }, [playing, total]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(t);
  }, [notice]);
  // Editing saves by itself; ⌘S saves at once and stays quiet. The save state
  // beside the title (and an error, if any) is the feedback.
  const save = useCallback(async () => {
    try {
      await command("project.save");
    } catch {
      /* shown inline */
    }
  }, [command]);
  // The listener is registered once and reads the latest render through a ref,
  // so a key pressed right after a state change never sees stale values.
  const live = useRef({ selectedIds, total, playing, preparing, settings, exportOpen, recent, home, requestPlayback, save, history, pending });
  live.current = { selectedIds, total, playing, preparing, settings, exportOpen, recent, home, requestPlayback, save, history, pending };
  /** A copy waiting for the edits made before it; a paste made meanwhile follows it. */
  const copying = useRef<Promise<void> | null>(null);
  const copySelection = useCallback(
    (cut: boolean) => {
      const active = current.current;
      if (!active || !live.current.selectedIds.length) return;
      const take = () => {
        const latest = current.current;
        const chosen = selectionNow.current;
        if (!latest || latest.id !== active.id || chosen.projectId !== latest.id) return;
        const ids = present(latest, chosen.ids);
        if (!ids.length) return;
        if (cut && !canEditSelection(latest, ids)) return;
        const clips = structuredClone(selectedClips(latest, ids));
        clipboard.current = { projectId: latest.id, clips };
        setClipboardProject(latest.id);
        if (!cut) setNotice(`클립 ${clips.length}개를 복사했습니다 · ⌘V로 재생 헤드에 붙여넣기`);
        else
          void safeCommand("edit.delete", (project) => {
            const remaining = present(project, ids);
            return canEditSelection(project, remaining) ? { ids: remaining } : null;
          }).then((result) => {
            if (result) selectMany([], null);
          });
      };
      const before = [...unsettledEdits.current, ...(copying.current ? [copying.current] : [])];
      if (!before.length) return take();
      // An edit made before this copy is still on its way (a split, a trim): the clips
      // are read once it has answered and selected what it made, not as they look now.
      const settled = Promise.allSettled(before)
        // A task later, so what those edits do with their answers (select the new half) is done.
        .then(() => new Promise<void>((resolve) => setTimeout(resolve)));
      // A cut's delete takes its place among the edits now, so that one made after it
      // (an undo, a delete, a move) is sent after it; only what it cuts is read at its turn.
      const turn: Promise<void> = (cut
        ? execute("edit.delete", (latest) => {
            const chosen = selectionNow.current;
            if (latest.id !== active.id || chosen.projectId !== latest.id) return null;
            const ids = present(latest, chosen.ids);
            if (!ids.length || !canEditSelection(latest, ids)) return null;
            clipboard.current = { projectId: latest.id, clips: structuredClone(selectedClips(latest, ids)) };
            setClipboardProject(latest.id);
            return { ids };
          }, false, settled).then((result) => {
            if (result) selectMany([], null);
          }, () => undefined)
        : settled.then(take)
      ).finally(() => {
        if (copying.current === turn) copying.current = null;
      });
      copying.current = turn;
    },
    [safeCommand, execute, selectMany],
  );
  const pasteAt = useCallback(
    (at: number) => {
      const paste = () => {
        const active = current.current;
        if (!active || clipboard.current?.projectId !== active.id) return;
        const clips = clipboard.current.clips;
        // What the paste added is told apart from the project it was sent on, not the
        // one on screen now: an edit still on its way may add clips of its own.
        let basis = active;
        void safeCommand("edit.paste", (latest) => {
          basis = latest;
          return { clips, at };
        }).then((result) => {
          const ids = newClipIds(basis, result);
          if (ids.length) selectMany(ids);
        });
      };
      if (copying.current) void copying.current.then(paste);
      else paste();
    },
    [safeCommand, selectMany],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const { selectedIds, total, playing, preparing, settings, exportOpen, recent, home, requestPlayback, save } = live.current;
      const time = playbackClock.get();
      if (recent) return; // The dialog handles its own keys (useModal).
      if (home) return; // No timeline to edit on the home screen.
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
        // Nothing to undo, and no edit on its way that could change that: the
        // service would only answer with an error.
        const { history, pending } = live.current;
        if (!pending && !(event.shiftKey ? history.canRedo : history.canUndo)) return;
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
        // Made when it is sent: a clip moved or trimmed by an edit still on its way
        // is cut where it then is, and one that is gone by then is left out.
        let basis = active;
        void safeCommand("edit.batch", (latest) => {
          basis = latest;
          const commands = clipEditCommands(latest, present(latest, selectedIds), time, action);
          return commands.length ? { commands } : null;
        }).then((updated) => {
          if (action === "split") {
            const ids = newClipIds(basis, updated);
            if (ids.length) selectMany(ids, ids[ids.length - 1]);
          }
        });
      } else if (cmd && key === "d" && selectedIds.length) {
        event.preventDefault();
        if (editable) {
          let basis = active;
          void safeCommand("edit.duplicate", (latest) => {
            basis = latest;
            const ids = present(latest, selectedIds);
            return canEditSelection(latest, ids) ? { ids } : null;
          }).then((result) => {
            const ids = newClipIds(basis, result);
            if (ids.length) selectMany(ids);
          });
        }
      } else if (
        cmd && !event.shiftKey && !event.altKey && (key === "c" || key === "x") &&
        selectedIds.length && !window.getSelection()?.toString()
      ) {
        event.preventDefault();
        copySelection(key === "x");
      } else if (cmd && !event.shiftKey && !event.altKey && key === "v" && (clipboard.current?.projectId === active.id || copying.current)) {
        event.preventDefault();
        if (event.repeat) return;
        pasteAt(time);
      } else if (cmd && key === "g" && selectedIds.length) {
        event.preventDefault();
        if (editable && (event.shiftKey || selectedIds.length > 1))
          void safeCommand(event.shiftKey ? "edit.ungroup" : "edit.group", (latest) => {
            const ids = present(latest, selectedIds);
            return canEditSelection(latest, ids) && (event.shiftKey || ids.length > 1) ? { ids } : null;
          });
      } else if (
        (event.key === "Backspace" || event.key === "Delete") &&
        selectedIds.length
      ) {
        event.preventDefault();
        if (editable)
          void safeCommand("edit.delete", (latest) => {
            const ids = present(latest, selectedIds);
            return canEditSelection(latest, ids) ? { ids, ripple: event.shiftKey } : null;
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
          // Made again when it is sent: a key that repeats faster than the service
          // answers moves on from where the step before left the clips.
          void execute("edit.batch", (latest) => {
            const ids = selectedIds.filter((id) => latest.clips.some((clip) => clip.id === id));
            const commands =
              event.key === "ArrowLeft" || event.key === "ArrowRight"
                ? moveSelection(
                    selectedClips(latest, ids),
                    (direction * (event.shiftKey ? 10 : 1)) / latest.fps,
                  )
                : shiftSelectionTracks(latest, ids, direction);
            return commands.length ? { commands } : null;
          }).catch(() => undefined);
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
        void safeCommand("edit.marker", () => ({ time, label: "마커" }));
      else if ((key === "i" || key === "o") && !cmd && !event.altKey && !event.shiftKey && total) {
        // Loop range: I marks its start and O its end at the playhead.
        const at = Math.min(total, time);
        setLoop((range) => {
          const base = range ?? { start: 0, end: total };
          const next = key === "i"
            ? { start: at, end: base.end > at ? base.end : total }
            : { start: base.start < at ? base.start : 0, end: at };
          return next.end - next.start >= 1 / active.fps ? next : null;
        });
      }
      else if (event.key === "Escape") {
        setMenu(false);
        selectMany([], null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [safeCommand, execute, selectMany, seekTime, copySelection, pasteAt]);
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
          // Followed through this window's own edits when it is sent.
          expectedRevision: current.current?.revision,
        });
    } catch (e) {
      setError(errorText(e).message);
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
      setError(errorText(e).message);
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
      setError(errorText(e).message);
    } finally {
      setBusy("");
      if (files.current) files.current.value = "";
    }
  };
  const example = async () => {
    setBusy("예제 프로젝트를 준비하고 있습니다");
    try {
      // An example that already exists is opened again rather than made once more.
      const existing = current.current?.name === EXAMPLE_PROJECT_NAME
        ? current.current
        : (await rpc<ProjectSummary[]>("project.list").catch(() => []))
            ?.find?.((item) => item.name === EXAMPLE_PROJECT_NAME);
      if (!existing) await command("project.demo");
      else if (existing.id !== current.current?.id) await command("project.open", { id: existing.id });
      playbackClock.seek(0);
      selectMany([], null);
      setHome(false);
    } catch {
      /* shown inline */
    } finally {
      setBusy("");
    }
  };
  const create = async (width = 1920, height = 1080) => {
    const created = await safeCommand("project.new", {
      name: DEFAULT_PROJECT_NAME,
      width,
      height,
      fps: 30,
    });
    setMenu(false);
    if (!created) return;
    playbackClock.seek(0);
    selectMany([], null);
    setHome(false);
  };
  const open = async (id: string) => {
    if (id !== current.current?.id) {
      const opened = await safeCommand("project.open", { id });
      if (!opened) return;
      playbackClock.seek(0);
      selectMany([], null);
    }
    setRecent(null);
    setHome(false);
  };
  const goHome = () => {
    setMenu(false);
    void requestPlayback(false);
    setHome(true);
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
  if (home)
    return (
      <>
        <Home
          currentId={project.id}
          hiddenId={isBlank(project) ? project.id : null}
          busy={!!busy || pending > 0}
          onCreate={(width, height) => void create(width, height)}
          onOpen={(id) => void open(id)}
          onExample={() => void example()}
          onSettings={() => setSettings(true)}
          reload={homeReload}
        />
        {(error || busy) && (
          <div className={`studio-notification ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
            {error ? <TriangleAlert size={14} /> : <LoaderCircle className="spin" size={14} />}
            <span>{error || busy}</span>
            {error && (
              <button title="알림 닫기" onClick={() => setError("")}>
                <X size={13} />
              </button>
            )}
          </div>
        )}
        {settings && (
          <Settings
            onClose={() => {
              setSettings(false);
              setHomeReload((count) => count + 1);
            }}
            onUpdate={setRuntime}
          />
        )}
      </>
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
            <button className="home-button" aria-label="홈" title="홈으로" onClick={goHome}>
              <span className="byori-mark">b</span>
              <strong>
                Byori <span>Studio</span>
              </strong>
            </button>
            <div className="menu-container">
              <button className="menu-toggle icon-button" aria-label="메뉴" title="메뉴" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <Ellipsis size={17} />
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
                        .catch((e) => setError(errorText(e).message));
                    }}
                  >
                    <FolderOpen size={15} /> 프로젝트 열기
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
                if (e.key === "Escape") {
                  // Leave the name as it was; the blur then has nothing to save.
                  e.stopPropagation();
                  e.currentTarget.value = project.name;
                  e.currentTarget.blur();
                }
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
            {!inspectorShown && (
              // The drawer has taken the inspector's column: this brings the inspector back.
              <button
                className="assistant-toggle"
                aria-label="속성 패널 열기"
                title="속성 패널 열기 · 창이 좁아 어시스턴트와 함께 둘 수 없어 어시스턴트를 닫습니다"
                onClick={() => {
                  // This button goes away with the click: focus follows to the panel it opened.
                  focusInspector.current = true;
                  setAssistant(false);
                }}
              >
                <SlidersHorizontal size={15} /> 속성
              </button>
            )}
            <button
              className={`assistant-toggle ${assistant ? "active" : ""}`}
              aria-pressed={assistant}
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
        <div className={`editor-workspace ${assistant && drawer.overlay ? "drawer-overlay" : ""}`}>
          <div
            className="editing-surface"
            ref={editingSurface}
            style={{
              gridTemplateRows: `minmax(${UPPER_MIN_HEIGHT}px, 1fr) ${TIMELINE_SEPARATOR}px ${timelineHeight}px`,
            }}
          >
            <div
              className={`upper-workspace ${inspectorShown ? "" : "inspector-hidden"}`}
              // Only chosen widths are set here; the stylesheet keeps the responsive defaults.
              style={{
                ...(panels.library ? { "--library-width": `${panels.library}px` } : {}),
                ...(panels.inspector ? { "--inspector-width": `${panels.inspector}px` } : {}),
              } as CSSProperties}
            >
              <Library
                project={project}
                targetTrackId={selectedTrackId}
                selected={selected}
                playhead={idleTime}
                now={playbackClock.get}
                onCommand={libraryCommand}
                onImport={() => void importPaths()}
                onSelect={selectClip}
              />
              <PanelResizer
                panel="library"
                label="라이브러리 폭 조절"
                value={layout.library}
                onChange={(library) => setLayout((value) => ({ ...value, library }))}
              />
              <Player
                project={withPreviewDraft(project, previewDraft)}
                draftActive={!!previewDraft}
                previewMode={previewMode}
                onPreviewMode={(mode) => {
                  void requestPlayback(false);
                  setRendered(null);
                  setPreviewMode(mode);
                }}
                playing={playing}
                onTime={seekTime}
                onPlaying={(v) => void requestPlayback(v)}
                loop={activeLoop}
                loopTarget={selectionRange}
                onLoop={setLoop}
                playbackUrl={playbackUrl}
                preparing={preparing}
                selectedId={selectedId}
                onSelect={selectClip}
                onCommand={safeCommand}
              />
              <PanelResizer
                panel="inspector"
                label="속성 패널 폭 조절"
                value={layout.inspector}
                onChange={(inspector) => setLayout((value) => ({ ...value, inspector: inspector ?? defaultLayout.inspector }))}
              />
              <Inspector
                project={project}
                selected={selected}
                onCommand={panelCommand}
                playhead={idleTime}
                now={playbackClock.get}
                covered={assistant && drawer.overlay}
              />
            </div>
            <div
              className="timeline-resizer"
              role="separator"
              aria-label="타임라인 높이 조절"
              aria-orientation="horizontal"
              aria-valuemin={TIMELINE_MIN_HEIGHT}
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
                    ? TIMELINE_MIN_HEIGHT
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
              onTime={seekTime}
              loop={activeLoop}
              onLoop={setLoop}
              onCopy={copySelection}
              onPaste={pasteAt}
              canPaste={clipboardProject === project.id}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onSelection={selectMany}
              onCommand={safeCommand}
              waveforms={waveforms}
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
            <span>전체 {total.toFixed(2)}초</span>
            {selectedIds.length > 0 && (
              <>
                <span className="status-separator" />
                <span>{selectedIds.length}개 선택</span>
              </>
            )}
          </div>
          <div>
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
          <div
            className="modal-backdrop"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setRecent(null);
            }}
          >
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
                    onClick={() => void open(p.id)}
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
