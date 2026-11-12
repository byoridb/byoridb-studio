import { useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Captions,
  Check,
  Film,
  Image,
  Import,
  LoaderCircle,
  Music2,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sticker,
  Trash2,
  TriangleAlert,
  Type,
  WandSparkles,
  X,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { assetUrl, pickFiles, savePath, uploadFile } from "./api";
import {
  freeTextY,
  incomingTransitionCommands,
  overlapWithPrevious,
  previousClip,
  separateTransitionCommands,
  stickerUrl,
  stickers,
  textDefaults,
  textPresets,
  transitionPatch,
  transitionsFor,
  type StickerAsset,
} from "./clipPresets";
import { errorText, type ErrorText } from "./errorText";
import type { Clip, Command, Media, Project, TransitionType } from "./types";
import SpeechPanel from "./SpeechPanel";
import { FontLibrary, PresetLibrary } from "./CustomAssets";
import { usePreviewDraft } from "./previewDraft";
import { textStyle } from "./fastPreview";
import "./panels.css";

export interface LibraryProps {
  project: Project;
  selected: Clip | null;
  onCommand: Command;
  onImport: () => void;
  onSelect: (clipId: string) => void;
  playhead?: number;
  /** The live playhead at the moment of an action; `playhead` holds still during playback. */
  now?: () => number;
  targetTrackId?: string | null;
}
type Tab =
  | "media"
  | "audio"
  | "text"
  | "stickers"
  | "effects"
  | "transitions"
  | "captions"
  | "filters";
const tabs: { id: Tab; label: string; icon: typeof Film }[] = [
  { id: "media", label: "미디어", icon: Film },
  { id: "audio", label: "오디오", icon: Music2 },
  { id: "text", label: "텍스트", icon: Type },
  { id: "stickers", label: "스티커", icon: Sticker },
  { id: "effects", label: "효과", icon: WandSparkles },
  { id: "transitions", label: "전환", icon: SlidersHorizontal },
  { id: "captions", label: "자막", icon: Captions },
  { id: "filters", label: "필터", icon: Sparkles },
];
const audioDefaults = { normalize: false, denoise: false, voiceEnhance: false };
// Ids and values mirror the editor's built-in filter presets; the editor owns
// the applied values, these copies only drive thumbnails and hover previews.
const filters = [
  {
    id: "none",
    name: "원본",
    color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  },
  {
    id: "cinematic",
    name: "시네마",
    color: { brightness: -0.02, contrast: 1.15, saturation: 0.85, temperature: 0 },
  },
  {
    id: "warm",
    name: "따뜻한 오후",
    color: { brightness: 0.02, contrast: 1.03, saturation: 1.05, temperature: 0.5 },
  },
  {
    id: "cool",
    name: "쿨 블루",
    color: { brightness: 0, contrast: 1.05, saturation: 0.95, temperature: -0.5 },
  },
  {
    id: "mono",
    name: "모노",
    color: { brightness: 0, contrast: 1.1, saturation: 0, temperature: 0 },
  },
  {
    id: "vintage",
    name: "빈티지",
    color: { brightness: 0.03, contrast: 0.9, saturation: 0.75, temperature: 0.3 },
  },
];
const maskPresets = [
  {
    name: "원형 프레임",
    type: "circle",
    width: 0.85,
    height: 0.85,
    feather: 0,
  },
  {
    name: "소프트 원형",
    type: "circle",
    width: 0.95,
    height: 0.95,
    feather: 0.25,
  },
  {
    name: "사각 프레임",
    type: "rectangle",
    width: 0.85,
    height: 0.85,
    feather: 0,
  },
  {
    name: "마스크 해제",
    type: "none",
    width: 1,
    height: 1,
    feather: 0,
  },
];
function durationLabel(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function previewFilter(color: (typeof filters)[number]["color"]) {
  return `brightness(${1 + color.brightness}) contrast(${color.contrast}) saturate(${color.saturation}) sepia(${Math.max(0, color.temperature) * 0.5})`;
}

export function Library({
  project,
  selected,
  onCommand,
  onImport,
  onSelect,
  playhead = 0,
  now,
  targetTrackId,
}: LibraryProps) {
  const preview = usePreviewDraft();
  const [tab, setTab] = useState<Tab>("media");
  const [search, setSearch] = useState("");
  const [mediaFilter, setMediaFilter] = useState("all");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setFailure] = useState<ErrorText | null>(null);
  /** Empty clears the error; `subject` names what an OS error was about. */
  const setError = (value: unknown, subject?: string) =>
    setFailure(value === "" ? null : errorText(value, subject));
  const [notice, setNotice] = useState("");
  const [captionPath, setCaptionPath] = useState("");
  const [brokenThumbs, setBrokenThumbs] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ media: Media; x: number; y: number } | null>(null);
  const [transitionLength, setTransitionLength] = useState(0.5);
  const query = search.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(query);
  const builtInMatches =
    tab === "text"
      ? textPresets.filter((p) => matches(p.name)).length
      : tab === "stickers"
        ? stickers.filter((p) => matches(p.name)).length
        : tab === "filters"
          ? filters.filter((p) => matches(p.name)).length
          : tab === "transitions"
            ? transitionsFor(selected).filter((p) => matches(p.name)).length
            : maskPresets.filter((p) => matches(p.name)).length;
  const assets = useMemo(
    () =>
      project.media.filter(
        (m) =>
          (tab !== "audio" || m.kind === "audio" || m.hasAudio) &&
          (mediaFilter === "all" || m.kind === mediaFilter) &&
          m.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [project.media, tab, mediaFilter, search],
  );
  const representative =
    project.media.find(
      (m) => m.id === selected?.mediaId && m.kind !== "audio",
    ) || project.media.find((m) => m.kind !== "audio");
  const audioToRecheck = project.media.filter((media) =>
    media.kind === "video" && /\.(mp3|m4a|aac|flac|ogg|opus|wav|wma)$/i.test(media.path),
  );
  const targetTrack = project.tracks.find((track) => track.id === targetTrackId);
  const run = async (
    key: string,
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    setPending(key);
    setError("");
    setNotice("");
    try {
      const result = await onCommand(method, params);
      if (
        method === "edit.add" &&
        result &&
        typeof result === "object" &&
        "clips" in result
      ) {
        const updated = result as Project;
        const added = updated.clips.find(
          (c) => !project.clips.some((old) => old.id === c.id),
        );
        if (added) onSelect(added.id);
      }
      return result;
    } catch (e) {
      setError(e, method.startsWith("captions.") ? "자막 파일" : undefined);
    } finally {
      setPending(null);
    }
  };
  const addMedia = async (media: Media) => {
    if (tab === "audio" && media.kind !== "audio") {
      let track = targetTrack?.kind === "audio" ? targetTrack : project.tracks.find((t) => t.kind === "audio" && !t.locked);
      if (!track) {
        const result = (await run(`track-${media.id}`, "edit.track", {
          kind: "audio",
          name: "오디오",
        })) as Project | undefined;
        track = result?.tracks.find((t) => t.kind === "audio" && !t.locked);
        if (!track) return;
      }
      await run(media.id, "edit.add", {
        mediaId: media.id,
        trackId: track.id,
        start: now?.() ?? playhead,
      });
    } else
      await run(media.id, "edit.add", {
        mediaId: media.id, start: now?.() ?? playhead,
        ...(targetTrack?.kind === (media.kind === "audio" ? "audio" : "video") ? { trackId: targetTrack.id } : {}),
      });
  };
  const removeMedia = (media: Media) => {
    if (project.clips.some((clip) => clip.mediaId === media.id)) {
      setError("");
      setNotice(
        `‘${media.name}’은(는) 타임라인에서 사용 중입니다. 해당 클립을 먼저 삭제해 주세요.`,
      );
      return;
    }
    void run(`remove-${media.id}`, "media.remove", {
      id: media.id,
      expectedRevision: project.revision,
    });
  };
  const relinkMedia = async (media: Media) => {
    try {
      const files = await pickFiles();
      if (files?.[0])
        await run(`relink-${media.id}`, "media.relink", {
          id: media.id,
          path: files[0],
          expectedRevision: project.revision,
        });
      else if (files === null)
        setNotice(
          "브라우저에서는 CLI의 media.relink 명령으로 원본 경로를 다시 지정할 수 있습니다.",
        );
    } catch (e) {
      setError(e);
    }
  };
  const addText = (label: string, style: Record<string, unknown> = {}) => {
    const start = now?.() ?? playhead;
    // Text already on screen at that time keeps its place; the new one goes above it.
    const y = freeTextY(project, start, 3);
    return run(label, "edit.add", {
      start,
      duration: 3,
      ...(targetTrack?.kind === "text" ? { trackId: targetTrack.id } : {}),
      text: { ...textDefaults, content: label, ...style },
      ...(y === undefined ? {} : { transform: { y } }),
    });
  };
  const patchSelected = (key: string, patch: Record<string, unknown>) =>
    selected
      ? run(key, "edit.update", {
          id: selected.id,
          patch,
          expectedRevision: project.revision,
        })
      : undefined;
  const addSticker = async (sticker: StickerAsset) => {
    setPending(sticker.id);
    setError("");
    setNotice("");
    try {
      let media = project.media.find(
        (m) => m.kind === "image" && !m.missing && m.name.endsWith(sticker.file),
      );
      let revision = project.revision;
      if (!media) {
        const response = await fetch(stickerUrl(sticker));
        const image = response.ok ? await response.blob() : null;
        if (!image || !image.type.startsWith("image/"))
          throw new Error("스티커 이미지를 불러오지 못했습니다.");
        const updated = await uploadFile(
          new File([image], sticker.file, { type: "image/png" }),
          project.id,
        );
        media = updated.media.find(
          (m) => !project.media.some((old) => old.id === m.id),
        );
        revision = updated.revision;
        if (!media) throw new Error("스티커를 소재로 가져오지 못했습니다.");
      }
      // A sticker starts as an overlay, not a full-frame image.
      const added = (await onCommand("edit.add", {
        mediaId: media.id,
        start: now?.() ?? playhead,
        duration: 3,
        name: `${sticker.name} 스티커`,
        transform: { scale: 0.35 },
        expectedRevision: revision,
        ...(targetTrack?.kind === "video" ? { trackId: targetTrack.id } : {}),
      })) as Project;
      const clip = added.clips.find(
        (c) => c.mediaId === media!.id && !project.clips.some((old) => old.id === c.id),
      );
      if (clip) onSelect(clip.id);
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  };
  const transitions = transitionsFor(selected);
  // The transition tab only joins a clip to the one before it; a clip's own
  // entrance and exit are animations in the inspector.
  const before = selected ? previousClip(project, selected) : null;
  const joined = selected ? overlapWithPrevious(project, selected) > 0 : false;
  const currentTransition = joined ? (selected?.transitionIn ?? null) : null;
  useEffect(() => {
    if (currentTransition) setTransitionLength(currentTransition.duration);
  }, [selected?.id, currentTransition?.duration]);
  const batchSelected = (
    key: string,
    commands: { method: string; params: Record<string, unknown> }[],
  ) =>
    commands.length
      ? run(key, "edit.batch", { commands, expectedRevision: project.revision })
      : undefined;
  const applyTransition = (type: TransitionType | null, length = transitionLength) =>
    selected &&
    before &&
    batchSelected(
      `transition-${type}`,
      type
        ? incomingTransitionCommands(project, selected, { type, duration: length })
        : separateTransitionCommands(project, selected),
    );
  const previewTransition = (type: TransitionType | null) =>
    selected &&
    before &&
    preview(
      selected.id,
      type ? transitionPatch(selected, "in", type, transitionLength) : null,
    );
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const setCurrentTab = (value: Tab) => {
    setTab(value);
    setSearch("");
    setMediaFilter("all");
    setError("");
    setNotice("");
  };

  return (
    <section className="studio-library" aria-label="소재 라이브러리">
      <div className="library-tabs" role="tablist" aria-label="편집 소재">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            className={tab === id ? "active" : ""}
            aria-selected={tab === id}
            aria-label={label}
            title={label}
            onClick={() => setCurrentTab(id)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="library-body">
        <div className="library-content">
          {tab !== "captions" && (
            <label className="panel-search">
              <Search size={14} />
              <input
                aria-label="소재 검색"
                placeholder={`${tabs.find((t) => t.id === tab)!.label} 검색`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button aria-label="검색 지우기" onClick={() => setSearch("")}>
                  <X size={13} />
                </button>
              )}
            </label>
          )}
          {(tab === "media" || tab === "audio") && (
            <>
              <div className="library-actions">
                <button className="panel-action-button" onClick={onImport}>
                  <Import size={14} />
                  가져오기
                </button>
                <span className="asset-count">{assets.length}개</span>
              </div>
              {tab === "media" && (
                <div className="library-chips" role="group" aria-label="소재 종류">
                  {(
                    [
                      ["all", "전체"],
                      ["video", "동영상"],
                      ["image", "이미지"],
                      ["audio", "오디오"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={mediaFilter === id ? "active" : ""}
                      aria-pressed={mediaFilter === id}
                      onClick={() => setMediaFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {audioToRecheck.length > 0 && <button
                className="panel-action-button"
                disabled={pending !== null}
                onClick={() => void run("reprobe", "media.reprobe", {
                  ids: audioToRecheck.map((media) => media.id),
                  expectedRevision: project.revision,
                })}
              ><AudioLines size={14} />오디오 분류 다시 확인 ({audioToRecheck.length})</button>}
              {assets.length > 0 ? (
                <div className="media-grid">
                  {assets.map((media) => (
                    <article
                      className="media-tile"
                      key={media.id}
                      draggable={!media.missing}
                      tabIndex={0}
                      aria-label={media.name}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ media, x: e.clientX, y: e.clientY });
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          removeMedia(media);
                        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                          e.preventDefault();
                          const box = e.currentTarget.getBoundingClientRect();
                          setMenu({ media, x: box.left + 12, y: box.top + 12 });
                        }
                      }}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "application/x-studio-media",
                          media.id,
                        );
                        e.dataTransfer.setData("text/plain", media.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    >
                      <div
                        className="media-thumb"
                        onDoubleClick={() =>
                          !media.missing && void addMedia(media)
                        }
                      >
                        {media.kind === "audio" ? (
                          <div className="audio-asset-art">
                            <AudioLines size={34} />
                          </div>
                        ) : media.missing ||
                          brokenThumbs.includes(`${media.id}:${media.path}`) ? (
                          <div className="audio-asset-art">
                            {media.kind === "video" ? (
                              <Film size={30} />
                            ) : (
                              <Image size={30} />
                            )}
                          </div>
                        ) : (
                          <img
                            src={assetUrl(media.id, true)}
                            alt=""
                            draggable={false}
                            onError={() =>
                              setBrokenThumbs((keys) => [
                                ...keys,
                                `${media.id}:${media.path}`,
                              ])
                            }
                          />
                        )}
                        {media.missing && (
                          <span className="media-missing">
                            <TriangleAlert size={11} /> 원본 없음
                          </span>
                        )}
                        <span className="media-kind">
                          {media.kind === "video" ? (
                            <Film size={11} />
                          ) : media.kind === "image" ? (
                            <Image size={11} />
                          ) : (
                            <Music2 size={11} />
                          )}
                        </span>
                        {media.kind !== "image" && (
                          <span className="media-duration">
                            {durationLabel(media.duration)}
                          </span>
                        )}
                        <button
                          className="add-media"
                          title="타임라인에 추가"
                          aria-label={`${media.name} 타임라인에 추가`}
                          disabled={pending !== null || media.missing}
                          onClick={() => void addMedia(media)}
                        >
                          {pending === media.id ? (
                            <LoaderCircle size={15} className="panel-spin" />
                          ) : (
                            <Plus size={15} />
                          )}
                        </button>
                      </div>
                      <p title={media.name}>{media.name}</p>
                      {media.missing && (
                        <button
                          className="relink-media"
                          disabled={pending !== null}
                          aria-label={`${media.name} 원본 다시 연결`}
                          onClick={() => void relinkMedia(media)}
                        >
                          다시 연결
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="library-empty">
                  <Film size={30} />
                  <strong>
                    {search
                      ? "검색 결과가 없습니다"
                      : "소재를 가져와 시작하세요"}
                  </strong>
                  <p>
                    {search
                      ? "다른 이름으로 검색해 보세요."
                      : "영상, 이미지, 오디오를 추가하거나 이곳에 끌어다 놓으세요."}
                  </p>
                  {!search && (
                    <button className="panel-action-button" onClick={onImport}>
                      <Plus size={14} />
                      미디어 가져오기
                    </button>
                  )}
                </div>
              )}
              {assets.length > 0 && !project.clips.length && (
                <p className="panel-help">
                  소재를 타임라인으로 끌어 놓거나 +를 눌러 추가하세요.
                </p>
              )}
              {tab === "audio" &&
                selected &&
                (selected.kind === "audio" ||
                  project.media.find((m) => m.id === selected.mediaId)
                    ?.hasAudio) && (
                  <>
                    <h3 className="library-section-title audio-presets-title">
                      오디오 다듬기
                    </h3>
                    <div className="audio-preset-row">
                      <button
                        disabled={pending !== null}
                        onClick={() =>
                          void patchSelected("voice", {
                            // Only what changes when the clip has its audio settings: the service merges.
                            audio: {
                              ...(selected.audio ? {} : audioDefaults),
                              denoise: true,
                              voiceEnhance: true,
                            },
                          })
                        }
                      >
                        <AudioLines size={17} />
                        <span>선명한 음성</span>
                      </button>
                      <button
                        disabled={pending !== null}
                        onClick={() =>
                          void patchSelected("normalize", {
                            audio: {
                              ...(selected.audio ? {} : audioDefaults),
                              normalize: true,
                            },
                          })
                        }
                      >
                        <SlidersHorizontal size={17} />
                        <span>음량 정규화</span>
                      </button>
                    </div>
                  </>
                )}
            </>
          )}
          {tab === "text" && (
            <>
              <button
                className="add-basic-text"
                disabled={pending !== null}
                onClick={() => void addText("텍스트를 입력하세요")}
              >
                <Type size={22} />
                <span>기본 텍스트 추가</span>
                <Plus size={16} />
              </button>
              {targetTrack?.kind === "text" && <p className="panel-help">추가할 트랙: {targetTrack.name}</p>}
              <FontLibrary project={project} selected={selected} onCommand={onCommand} query={query} />
              <h3 className="library-section-title">텍스트 프리셋</h3>
              <div className="text-preset-grid">
                {textPresets.map((item) => matches(item.name) && (
                  <button
                    className="text-preset"
                    disabled={pending !== null}
                    key={item.name}
                    onClick={() => void addText(item.label, item.style)}
                  >
                    <span>
                      <i
                        style={{
                          ...textStyle(
                            { ...textDefaults, content: "", ...item.style },
                            0.3,
                            project.width,
                          ),
                          fontStyle: item.style.italic ? "italic" : "normal",
                        }}
                      >
                        Aa
                      </i>
                    </span>
                    <small>{item.name}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "stickers" && (
            <>
              <h3 className="library-section-title">
                스티커 <span>{builtInMatches}</span>
              </h3>
              <div className="sticker-grid">
                {stickers.map((sticker) => matches(sticker.name) && (
                  <button
                    key={sticker.id}
                    className="sticker-tile"
                    disabled={pending !== null}
                    aria-label={`${sticker.name} 스티커 추가`}
                    title={sticker.name}
                    onClick={() => void addSticker(sticker)}
                  >
                    {pending === sticker.id ? (
                      <LoaderCircle size={18} className="panel-spin" />
                    ) : (
                      <img src={stickerUrl(sticker)} alt="" draggable={false} />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "filters" && (
            <>
              <PresetLibrary kind="filter" project={project} selected={selected} onCommand={onCommand} query={query} />
              <h3 className="library-section-title">
                컬러 프리셋 <span>{builtInMatches}</span>
              </h3>
              {!selected && (
                <p className="panel-hint">
                  필터를 적용할 영상이나 이미지를 선택하세요.
                </p>
              )}
              <div className="filter-grid">
                {filters.map((filter) => matches(filter.name) && (
                  <button
                    key={filter.id}
                    className={`filter-preset ${selected?.filter === filter.id ? "active" : ""}`}
                    disabled={
                      !selected ||
                      selected.kind === "audio" ||
                      selected.kind === "text" ||
                      pending !== null
                    }
                    onMouseEnter={() => selected && preview(selected.id, { color: filter.color, filter: filter.id })}
                    onMouseLeave={() => selected && preview(selected.id, null)}
                    onFocus={() => selected && preview(selected.id, { color: filter.color, filter: filter.id })}
                    onBlur={() => selected && preview(selected.id, null)}
                    onClick={() =>
                      void patchSelected(filter.id, { filter: filter.id })
                    }
                  >
                    <div className="filter-preview">
                      {representative ? (
                        <img
                          src={assetUrl(representative.id, true)}
                          alt=""
                          style={{ filter: previewFilter(filter.color) }}
                        />
                      ) : (
                        <Image size={28} />
                      )}{" "}
                      {selected?.filter === filter.id && (
                        <span className="preset-check">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                    <span>{filter.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "transitions" && (
            <>
              <h3 className="library-section-title">
                클립 사이 전환 <span>{builtInMatches}</span>
              </h3>
              {!before && (
                <p className="panel-hint">
                  {selected
                    ? "앞 클립과 맞닿아 있는 클립을 선택하세요."
                    : "전환을 넣을 뒤쪽 클립을 타임라인에서 선택하세요."}
                </p>
              )}
              <div className="transition-controls">
                <label>
                  길이
                  <input
                    aria-label="전환 길이"
                    type="number"
                    min={0.1}
                    max={Math.max(0.1, (selected?.duration ?? 20) / 2)}
                    step={0.1}
                    value={transitionLength}
                    onChange={(e) =>
                      setTransitionLength(
                        Math.max(0.1, Number(e.target.value) || 0.1),
                      )
                    }
                    onBlur={() => {
                      if (
                        currentTransition &&
                        Math.abs(currentTransition.duration - transitionLength) > 1e-6
                      )
                        void applyTransition(currentTransition.type);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                  <small>초</small>
                </label>
                {joined && (
                  <button
                    className="panel-action-button"
                    disabled={pending !== null}
                    onClick={() => void applyTransition(null)}
                  >
                    <Trash2 size={13} />
                    전환 제거
                  </button>
                )}
              </div>
              <div className="effect-preset-grid">
                {transitions.map((item) => matches(item.name) && (
                  <button
                    key={item.id}
                    className={currentTransition?.type === item.id ? "active" : ""}
                    aria-pressed={currentTransition?.type === item.id}
                    disabled={!before || pending !== null}
                    onMouseEnter={() => previewTransition(item.id)}
                    onMouseLeave={() => previewTransition(null)}
                    onFocus={() => previewTransition(item.id)}
                    onBlur={() => previewTransition(null)}
                    onClick={() => void applyTransition(item.id)}
                  >
                    <span className={`transition-art in ${item.id}`}>
                      <i
                        style={
                          representative
                            ? { backgroundImage: `url(${JSON.stringify(assetUrl(representative.id, true))})` }
                            : undefined
                        }
                      />
                      {currentTransition?.type === item.id && (
                        <span className="preset-check">
                          <Check size={12} />
                        </span>
                      )}
                    </span>
                    <small>{item.name}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "effects" && (
            <>
              <PresetLibrary kind="effect" project={project} selected={selected} onCommand={onCommand} query={query} />
              <h3 className="library-section-title frames-title">
                프레임 마스크
              </h3>
              {(!selected || selected.kind === "audio") && (
                <p className="panel-hint">
                  마스크를 적용할 영상, 이미지 또는 텍스트를 선택하세요.
                </p>
              )}
              <div className="effect-preset-grid">
                {maskPresets.map((effect) => matches(effect.name) && (
                  <button
                    key={effect.name}
                    disabled={
                      !selected || selected.kind === "audio" || pending !== null
                    }
                    onClick={() =>
                      void patchSelected(effect.name, {
                        mask: {
                          type: effect.type,
                          x: 0.5,
                          y: 0.5,
                          width: effect.width,
                          height: effect.height,
                          feather: effect.feather,
                        },
                      })
                    }
                  >
                    <span
                      className={`mask-preset-art ${effect.type} ${effect.feather ? "soft" : ""}`}
                    >
                      <i />
                    </span>
                    <small>{effect.name}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "captions" && (
            <>
              <h3 className="library-section-title">자막 파일</h3>
              <div className="caption-drop">
                <Captions size={28} />
                <strong>SRT 자막 가져오기</strong>
                {isTauri() ? (
                  <button
                    className="panel-action-button"
                    disabled={pending !== null}
                    onClick={async () => {
                      try {
                        const files = await pickFiles(["srt"]);
                        if (files?.[0])
                          await run("caption-import", "captions.import", {
                            path: files[0],
                          });
                      } catch (e) {
                        setError(e, "자막 파일");
                      }
                    }}
                  >
                    <Import size={14} />
                    파일 선택
                  </button>
                ) : (
                  // The browser build has no file dialog for local paths.
                  <form
                    className="caption-path"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (captionPath.trim())
                        void run("caption-import", "captions.import", {
                          path: captionPath.trim(),
                        });
                    }}
                  >
                    <input
                      aria-label="자막 파일 경로"
                      value={captionPath}
                      onChange={(e) => setCaptionPath(e.target.value)}
                      placeholder="/Users/…/captions.srt"
                    />
                    <button
                      className="panel-action-button"
                      disabled={!captionPath.trim() || pending !== null}
                    >
                      자막 가져오기
                    </button>
                  </form>
                )}
              </div>
              <button
                className="panel-wide-button secondary"
                disabled={
                  !project.clips.some((c) => c.kind === "text") ||
                  pending !== null
                }
                onClick={async () => {
                  try {
                    const path = await savePath(`${project.name}.srt`, "srt");
                    if (path) {
                      const result = await run(
                        "caption-export",
                        "captions.export",
                        // The native save dialog already confirmed replacing a file.
                        { path, overwrite: true },
                      );
                      if (result) setNotice(`자막을 저장했습니다: ${path}`);
                    } else {
                      setNotice(
                        "브라우저에서는 CLI의 captions.export 명령으로 저장 경로를 지정할 수 있습니다.",
                      );
                    }
                  } catch (e) {
                    setError(e, "자막 파일");
                  }
                }}
              >
                자막 파일 내보내기
              </button>
            </>
          )}
          {query &&
            builtInMatches === 0 &&
            !["media", "audio", "captions"].includes(tab) && (
              <p className="panel-hint" role="status">
                기본 소재에 검색 결과가 없습니다.
              </p>
            )}
          <SpeechPanel
            mode={tab === "audio" ? "synthesize" : "transcribe"}
            visible={tab === "audio" || tab === "captions"}
            project={project}
            playhead={playhead}
            onCommand={onCommand}
          />
          {pending && (
            <div className="panel-working" role="status">
              <LoaderCircle className="panel-spin" size={13} />
              적용 중…
            </div>
          )}
          {notice && (
            <p className="panel-notice" role="status">
              {notice}
            </p>
          )}
        </div>
      </div>
      {/* Outside the scroll area so a failure is visible wherever the list is scrolled. */}
      {error && (
        <div className="panel-inline-error pinned" role="alert" title={error.detail}>
          {error.message}
          <button aria-label="오류 닫기" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      )}
      {menu && (
        <div
          className="library-menu"
          role="menu"
          aria-label={`${menu.media.name} 소재 메뉴`}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            autoFocus
            disabled={pending !== null}
            onClick={() => {
              removeMedia(menu.media);
              setMenu(null);
            }}
          >
            <Trash2 size={13} />
            프로젝트에서 삭제
          </button>
        </div>
      )}
    </section>
  );
}

export default Library;
