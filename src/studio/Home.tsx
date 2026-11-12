import { useCallback, useEffect, useState } from "react";
import { Copy, Film, LoaderCircle, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { projectThumbnailUrl, rpc } from "./api";

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string | number;
  /** The earliest picture of the project that already has a thumbnail (project.list). */
  thumbnail?: { mediaId: string };
  /** No clips and no media yet (project.list). */
  empty?: boolean;
}
/** The name project.demo gives the example; an existing one is reopened instead of made again. */
export const EXAMPLE_PROJECT_NAME = "잠시, 멈추는 여행 · 예제";
export const DEFAULT_PROJECT_NAME = "이름 없는 프로젝트";
/** The names a project has before anyone names it. */
export const UNNAMED = [DEFAULT_PROJECT_NAME, "새 프로젝트"];
export const FRAME_PRESETS = [
  { ratio: "16:9", label: "가로", width: 1920, height: 1080 },
  { ratio: "9:16", label: "세로", width: 1080, height: 1920 },
  { ratio: "1:1", label: "정사각형", width: 1080, height: 1080 },
  { ratio: "4:5", label: "피드", width: 1080, height: 1350 },
] as const;

/** "오늘 오전 2:35", "어제 오후 9:10", then the date (with the year once it differs). */
export const relativeDate = (value: string | number, now = new Date()) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0 || days === 1)
    return `${days ? "어제" : "오늘"} ${date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}`;
  return date.toLocaleDateString("ko-KR", {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
  });
};
const stamp = (value: string | number) => {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

/** The project's first frame; the film icon stands in when there is none or it cannot be read. */
function Cover({ item }: { item: ProjectSummary }) {
  // The cover that could not be read. Kept by its media id rather than reset in an
  // effect: an effect that runs after the image has already failed would undo it.
  const [failed, setFailed] = useState<string | null>(null);
  const mediaId = item.thumbnail?.mediaId;
  const url = mediaId && failed !== mediaId ? projectThumbnailUrl(item.id, mediaId) : "";
  return url
    ? <img src={url} alt="" draggable={false} onError={() => setFailed(mediaId ?? null)} />
    : <Film size={22} aria-hidden="true" />;
}

export default function Home({
  currentId,
  hiddenId,
  busy,
  onCreate,
  onOpen,
  onExample,
  onSettings,
}: {
  /** The project the editor already holds: opening it only leaves the home screen. */
  currentId: string;
  /** A project to leave out of the list: the untouched one the app created by itself. */
  hiddenId?: string | null;
  busy?: boolean;
  onCreate: (width: number, height: number) => void;
  onOpen: (id: string) => void;
  onExample: () => void;
  onSettings: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const load = useCallback(
    () =>
      rpc<ProjectSummary[]>("project.list")
        .then((list) => setProjects(Array.isArray(list) ? list : []))
        .catch((e) => {
          setProjects((known) => known ?? []);
          setError(e instanceof Error ? e.message : String(e));
        }),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  /** Store operations answer with the new list (or one summary); either way the grid is refreshed. */
  const act = async (id: string, method: string, params: Record<string, unknown>) => {
    setError("");
    setWorking(id);
    try {
      const result = await rpc<unknown>(method, params);
      if (Array.isArray(result)) setProjects(result as ProjectSummary[]);
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };
  const sorted = (projects ?? [])
    // Untouched projects the app made by itself are not the user's work to list.
    .filter((item) => item.id !== hiddenId && !(item.empty && UNNAMED.includes(item.name)))
    .sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt));
  const empty = projects !== null && !sorted.length;
  return (
    <main className="home-screen">
      <header className="home-header">
        <span className="byori-mark">b</span>
        <strong>
          Byori <span>Studio</span>
        </strong>
        <button className="icon-button" title="설정" aria-label="설정" onClick={onSettings}>
          <Settings2 size={17} />
        </button>
      </header>
      <div className="home-body">
        <section aria-labelledby="home-new">
          <div className="home-section-heading">
            <h2 id="home-new">새 프로젝트</h2>
            <small>화면 비율을 고르면 바로 편집을 시작합니다</small>
          </div>
          <div className="home-presets">
            {FRAME_PRESETS.map((preset) => (
              <button
                key={preset.ratio}
                disabled={busy}
                aria-label={`새 프로젝트 ${preset.ratio} ${preset.label}`}
                onClick={() => onCreate(preset.width, preset.height)}
              >
                <span className="home-preset-frame">
                  <i style={{ aspectRatio: `${preset.width} / ${preset.height}` }}>
                    <Plus size={14} aria-hidden="true" />
                  </i>
                </span>
                <strong>{preset.ratio}</strong>
                <small>
                  {preset.label} · {preset.width} × {preset.height}
                </small>
              </button>
            ))}
          </div>
        </section>
        <section aria-labelledby="home-recent">
          <div className="home-section-heading">
            <h2 id="home-recent">
              최근 프로젝트
              {sorted.length > 0 && <span className="home-count">{sorted.length}</span>}
            </h2>
            {/* With nothing saved the example is offered in the empty state below instead. */}
            {!empty && (
              <button
                className="home-example"
                title="제공된 사진과 합성 오디오로 만든 예제 프로젝트"
                disabled={busy}
                onClick={onExample}
              >
                예제 열기
              </button>
            )}
          </div>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          {projects === null ? (
            <p className="home-empty">
              <LoaderCircle className="spin" size={16} /> 프로젝트를 불러오고 있습니다.
            </p>
          ) : empty ? (
            <div className="home-empty-state">
              <Film size={22} aria-hidden="true" />
              <strong>아직 저장된 프로젝트가 없습니다</strong>
              <p>위에서 화면 비율을 골라 시작하거나, 예제로 먼저 둘러보세요.</p>
              <button
                className="secondary-button"
                title="제공된 사진과 합성 오디오로 만든 예제 프로젝트"
                disabled={busy}
                onClick={onExample}
              >
                예제 열기
              </button>
            </div>
          ) : (
            <ul className="home-grid">
              {sorted.map((item) => {
                const current = item.id === currentId;
                return (
                  <li key={item.id} className={current ? "current" : ""} aria-busy={working === item.id}>
                    <button
                      className="home-card-open"
                      aria-label={`${item.name} 열기`}
                      disabled={busy || working === item.id}
                      onClick={() => onOpen(item.id)}
                    >
                      <Cover item={item} />
                    </button>
                    <div className="home-card-text">
                      {renaming === item.id ? (
                        <input
                          aria-label="프로젝트 이름"
                          defaultValue={item.name}
                          maxLength={120}
                          autoFocus
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={(event) => {
                            const name = event.target.value.trim();
                            setRenaming(null);
                            if (name && name !== item.name) void act(item.id, "project.rename", { id: item.id, name });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              event.currentTarget.value = item.name;
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      ) : (
                        <strong title={item.name}>{item.name}</strong>
                      )}
                      <small>
                        {current ? "열려 있음 · " : ""}
                        {relativeDate(item.updatedAt)}
                      </small>
                    </div>
                    <div className={`home-card-actions ${deleting === item.id ? "confirming" : ""}`}>
                      {deleting === item.id ? (
                        <>
                          <button className="danger" onClick={() => { setDeleting(null); void act(item.id, "project.delete", { id: item.id }); }}>
                            삭제 확인
                          </button>
                          <button autoFocus onClick={() => setDeleting(null)}>취소</button>
                        </>
                      ) : (
                        <>
                          <button title="이름 변경" aria-label={`${item.name} 이름 변경`} onClick={() => setRenaming(item.id)}>
                            <Pencil size={14} />
                          </button>
                          <button title="복제" aria-label={`${item.name} 복제`} onClick={() => void act(item.id, "project.duplicate", { id: item.id })}>
                            <Copy size={14} />
                          </button>
                          <button
                            title={current ? "열려 있는 프로젝트는 삭제할 수 없습니다" : "프로젝트 삭제 · 되돌릴 수 없습니다"}
                            aria-label={`${item.name} 삭제`}
                            disabled={current}
                            onClick={() => setDeleting(item.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
