import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  Check,
  CirclePlus,
  ChevronLeft,
  ChevronRight,
  Film,
  Folder,
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
import { assetUrl, pickFiles, savePath, uploadFile } from "./api";
import {
  incomingTransitionCommands,
  joinTransitionCommands,
  overlapWithPrevious,
  previousClip,
  stickerUrl,
  stickers,
  textDefaults,
  textPresets,
  transitionOf,
  transitionPatch,
  transitionsFor,
  type Edge,
  type StickerAsset,
} from "./clipPresets";
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
const motionPresets = [
  { name: "천천히 확대", label: "108%", start: 1, end: 1.08 },
  { name: "천천히 축소", label: "100%", start: 1.08, end: 1 },
  { name: "가까이", label: "120%", start: 1, end: 1.2 },
  { name: "모션 초기화", label: "—", start: 1, end: 1 },
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
  const tabStrip = useRef<HTMLElement>(null);
  const [tabOverflow, setTabOverflow] = useState({
    overflow: false,
    left: false,
    right: false,
  });
  useEffect(() => {
    const element = tabStrip.current;
    if (!element) return;
    const measure = () =>
      setTabOverflow({
        overflow: element.scrollWidth > element.clientWidth + 2,
        left: element.scrollLeft > 2,
        right:
          element.scrollLeft + element.clientWidth < element.scrollWidth - 2,
      });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    element.addEventListener("scroll", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      element.removeEventListener("scroll", measure);
    };
  }, []);
  const scrollTabs = (direction: number) =>
    tabStrip.current?.scrollBy({ left: direction * 160, behavior: "smooth" });
  const [search, setSearch] = useState("");
  const [mediaFilter, setMediaFilter] = useState("all");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [captionPath, setCaptionPath] = useState("");
  const [brokenThumbs, setBrokenThumbs] = useState<string[]>([]);
  const [edge, setEdge] = useState<Edge>("in");
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
            : [...motionPresets, ...maskPresets].filter((p) => matches(p.name))
                .length;
  const pathInput = useRef<HTMLInputElement>(null);
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
      setError(
        e instanceof Error
          ? e.message
          : "작업을 완료하지 못했습니다. 다시 시도해 주세요.",
      );
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
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const addText = (label: string, style: Record<string, unknown> = {}) =>
    run(label, "edit.add", {
      start: now?.() ?? playhead,
      duration: 3,
      ...(targetTrack?.kind === "text" ? { trackId: targetTrack.id } : {}),
      text: { ...textDefaults, content: label, ...style },
    });
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };
  const transitions = transitionsFor(selected);
  const currentTransition = selected ? transitionOf(selected, edge) : null;
  const joined = selected ? overlapWithPrevious(project, selected) > 0 : false;
  const canJoin =
    !!selected && edge === "in" && !joined && !!previousClip(project, selected);
  const applyTransition = (type: TransitionType | null) =>
    selected &&
    // A joined clip overlaps the previous one by exactly its in transition.
    (edge === "in" && joined
      ? batchSelected(
          `transition-${type}`,
          incomingTransitionCommands(
            project,
            selected,
            type && { type, duration: transitionLength },
          ),
        )
      : patchSelected(
          `transition-${type}`,
          transitionPatch(selected, edge, type, transitionLength),
        ));
  const batchSelected = (
    key: string,
    commands: { method: string; params: Record<string, unknown> }[],
  ) =>
    commands.length
      ? run(key, "edit.batch", { commands, expectedRevision: project.revision })
      : undefined;
  const previewTransition = (type: TransitionType | null) =>
    selected &&
    preview(
      selected.id,
      type ? transitionPatch(selected, edge, type, transitionLength) : null,
    );
  const setCurrentTab = (value: Tab) => {
    setTab(value);
    setSearch("");
    setMediaFilter("all");
    setError("");
    setNotice("");
  };

  return (
    <section className="studio-library" aria-label="소재 라이브러리">
      <div className="library-tab-navigation">
        {tabOverflow.overflow && (
          <button
            className="library-tab-scroll"
            title="이전 소재 탭 보기"
            aria-label="이전 소재 탭 보기"
            disabled={!tabOverflow.left}
            onClick={() => scrollTabs(-1)}
          >
            <ChevronLeft size={15} />
          </button>
        )}
        <nav ref={tabStrip} className="library-tabs" aria-label="편집 소재">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setCurrentTab(id)}
              aria-pressed={tab === id}
              onFocus={(event) =>
                event.currentTarget.scrollIntoView?.({
                  block: "nearest",
                  inline: "nearest",
                })
              }
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {tabOverflow.overflow && (
          <button
            className="library-tab-scroll"
            title="다음 소재 탭 보기"
            aria-label="다음 소재 탭 보기"
            disabled={!tabOverflow.right}
            onClick={() => scrollTabs(1)}
          >
            <ChevronRight size={15} />
          </button>
        )}
      </div>
      <div className="library-body">
        <aside className="library-categories" aria-label="소재 분류">
          <div className="category-heading">
            {tab === "media"
              ? "로컬"
              : tab === "audio"
                ? "내 오디오"
                : tab === "text"
                  ? "텍스트 추가"
                  : tab === "captions"
                    ? "자막 파일"
                    : "기본"}
          </div>
          {(tab === "media" || tab === "audio") && (
            <>
              <button
                className={mediaFilter === "all" ? "selected" : ""}
                onClick={() => setMediaFilter("all")}
              >
                전체
              </button>
              {tab === "media" && (
                <>
                  <button
                    className={mediaFilter === "video" ? "selected" : ""}
                    onClick={() => setMediaFilter("video")}
                  >
                    동영상
                  </button>
                  <button
                    className={mediaFilter === "image" ? "selected" : ""}
                    onClick={() => setMediaFilter("image")}
                  >
                    이미지
                  </button>
                  <button
                    className={mediaFilter === "audio" ? "selected" : ""}
                    onClick={() => setMediaFilter("audio")}
                  >
                    오디오
                  </button>
                </>
              )}
            </>
          )}
          {tab === "filters" && (
            <span className="category-label">컬러 프리셋</span>
          )}
          {tab === "transitions" && (
            <span className="category-label">등장 · 퇴장</span>
          )}
          {tab === "effects" && <span className="category-label">모션</span>}
          {tab === "stickers" && (
            <span className="category-label">도형 · 기호</span>
          )}
          <div className="library-category-bottom">
            <Folder size={14} />
            <span>프로젝트 소재</span>
          </div>
        </aside>
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
                        <button
                          className="remove-media"
                          title="프로젝트에서 소재 삭제"
                          aria-label={`${media.name} 소재 삭제`}
                          disabled={pending !== null}
                          onClick={() => removeMedia(media)}
                        >
                          <Trash2 size={13} />
                        </button>
                        <span className="media-kind">
                          {media.kind === "video" ? (
                            <Film size={11} />
                          ) : media.kind === "image" ? (
                            <Image size={11} />
                          ) : (
                            <Music2 size={11} />
                          )}
                        </span>
                        <span className="media-duration">
                          {media.kind === "image"
                            ? "이미지"
                            : durationLabel(media.duration)}
                        </span>
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
              {assets.length > 0 && (
                <p className="panel-help">
                  소재를 타임라인으로 드래그하거나 +를 눌러 추가하세요.
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
                            audio: {
                              ...audioDefaults,
                              ...selected.audio,
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
                              ...audioDefaults,
                              ...selected.audio,
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
              <p className="panel-help">
                추가한 텍스트의 내용과 스타일은 오른쪽 패널에서 변경할 수
                있습니다.
              </p>
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
              <p className="panel-help">
                스티커는 이미지 소재로 프로젝트에 추가되어 재생 위치에
                놓입니다. 크기와 위치는 미리보기 화면이나 속성 패널에서
                조절하세요.
              </p>
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
                전환 <span>{builtInMatches}</span>
              </h3>
              {!selected && (
                <p className="panel-hint">
                  전환을 적용할 클립을 타임라인에서 선택하세요.
                </p>
              )}
              <div className="transition-controls">
                <div className="segmented" role="group" aria-label="전환 위치">
                  {(
                    [
                      ["in", "등장"],
                      ["out", "퇴장"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={edge === id ? "active" : ""}
                      aria-pressed={edge === id}
                      onClick={() => {
                        setEdge(id);
                        const existing = selected && transitionOf(selected, id);
                        if (existing) setTransitionLength(existing.duration);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label>
                  길이
                  <input
                    aria-label="전환 길이"
                    type="number"
                    min={0.1}
                    max={Math.max(0.1, selected?.duration ?? 10)}
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
              </div>
              <div className="effect-preset-grid">
                {transitions.map((item) => matches(item.name) && (
                  <button
                    key={item.id}
                    className={currentTransition?.type === item.id ? "active" : ""}
                    aria-pressed={currentTransition?.type === item.id}
                    disabled={!selected || pending !== null}
                    onMouseEnter={() => previewTransition(item.id)}
                    onMouseLeave={() => previewTransition(null)}
                    onFocus={() => previewTransition(item.id)}
                    onBlur={() => previewTransition(null)}
                    onClick={() => void applyTransition(item.id)}
                  >
                    <span className={`transition-art ${edge} ${item.id}`}>
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
              <button
                className="panel-wide-button secondary"
                disabled={!selected || !currentTransition || pending !== null}
                onClick={() =>
                  void applyTransition(null)
                }
              >
                <Trash2 size={13} />
                {edge === "in" ? "등장" : "퇴장"} 전환 제거
              </button>
              {canJoin && selected && (
                <button
                  className="panel-wide-button secondary"
                  disabled={pending !== null}
                  onClick={() =>
                    void batchSelected(
                      "transition-join",
                      joinTransitionCommands(
                        project,
                        selected,
                        currentTransition?.type ??
                          (selected.kind === "audio" ? "fade" : "dissolve"),
                        transitionLength,
                      ),
                    )
                  }
                >
                  앞 클립과 겹쳐 전환
                </button>
              )}
              <p className="panel-help">
                {joined
                  ? "이 클립은 앞 클립 위로 겹쳐 등장합니다. 전환을 제거하면 뒤 클립들이 원래 자리로 돌아갑니다."
                  : "전환은 선택한 클립이 나타나고 사라지는 방식입니다. ‘앞 클립과 겹쳐 전환’은 이 클립과 뒤 클립들을 전환 길이만큼 앞으로 당깁니다."}
              </p>
            </>
          )}
          {tab === "effects" && (
            <>
              <PresetLibrary kind="effect" project={project} selected={selected} onCommand={onCommand} query={query} />
              <h3 className="library-section-title">모션 프리셋</h3>
              <p className="panel-hint">
                선택한 클립에 편집 가능한 키프레임을 추가합니다.
              </p>
              <div className="effect-preset-grid">
                {motionPresets.map((effect) => matches(effect.name) && (
                  <button
                    key={effect.name}
                    disabled={
                      !selected || selected.kind === "audio" || pending !== null
                    }
                    onClick={() => {
                      if (!selected) return;
                      const untouched = selected.keyframes.filter(
                        (k) => k.property !== "transform.scale",
                      );
                      void patchSelected(effect.name, {
                        keyframes:
                          effect.name === "모션 초기화"
                            ? untouched
                            : [
                                ...untouched,
                                {
                                  property: "transform.scale",
                                  time: 0,
                                  value: effect.start,
                                },
                                {
                                  property: "transform.scale",
                                  time: selected.duration,
                                  value: effect.end,
                                },
                              ],
                      });
                    }}
                  >
                    <span className="motion-art">{effect.label}</span>
                    <small>{effect.name}</small>
                  </button>
                ))}
              </div>
              <h3 className="library-section-title frames-title">
                프레임 마스크
              </h3>
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
              <p className="panel-hint">
                SRT 자막을 타임라인에 가져오고, 텍스트처럼 편집하세요.
              </p>
              <div className="caption-drop">
                <Captions size={32} />
                <strong>SRT 자막 가져오기</strong>
                <p>시간 정보와 자막 내용을 함께 가져옵니다.</p>
                <button
                  className="panel-action-button"
                  disabled={pending !== null}
                  onClick={async () => {
                    try {
                      const files = await pickFiles();
                      if (files?.[0])
                        await run("caption-import", "captions.import", {
                          path: files[0],
                        });
                      else pathInput.current?.focus();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <Import size={14} />
                  파일 선택
                </button>
              </div>
              <label className="caption-path-label">
                자막 파일 경로
                <input
                  ref={pathInput}
                  value={captionPath}
                  onChange={(e) => setCaptionPath(e.target.value)}
                  placeholder="/Users/…/captions.srt"
                />
              </label>
              <button
                className="panel-wide-button"
                disabled={!captionPath.trim() || pending !== null}
                onClick={() =>
                  void run("caption-import", "captions.import", {
                    path: captionPath.trim(),
                  })
                }
              >
                자막 가져오기
              </button>
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
                    setError(String(e));
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
          {error && (
            <div className="panel-inline-error" role="alert">
              {error}
              <button aria-label="오류 닫기" onClick={() => setError("")}>
                <X size={13} />
              </button>
            </div>
          )}
          {notice && (
            <p className="panel-notice" role="status">
              {notice}
            </p>
          )}
        </div>
      </div>
      <footer className="library-footer">
        <CirclePlus size={13} />
        <span>
          {tab === "media" || tab === "audio"
            ? "소재를 추가하고 이야기를 시작하세요"
            : selected
              ? `선택: ${selected.name}`
              : "타임라인에서 클립을 선택하세요"}
        </span>
      </footer>
    </section>
  );
}

export default Library;
