import { useCallback, useEffect, useState } from "react";
import { Copy, Film, FolderOpen, LoaderCircle, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { rpc } from "./api";

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string | number;
}
export const DEFAULT_PROJECT_NAME = "이름 없는 프로젝트";
export const FRAME_PRESETS = [
  { ratio: "16:9", label: "가로", width: 1920, height: 1080 },
  { ratio: "9:16", label: "세로", width: 1080, height: 1920 },
  { ratio: "1:1", label: "정사각형", width: 1080, height: 1080 },
  { ratio: "4:5", label: "피드", width: 1080, height: 1350 },
] as const;

const when = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
};
const stamp = (value: string | number) => {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

export default function Home({
  currentId,
  busy,
  onCreate,
  onOpen,
  onExample,
  onSettings,
}: {
  /** The project the editor already holds: opening it only leaves the home screen. */
  currentId: string;
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
  const sorted = [...(projects ?? [])].sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt));
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
          <h2 id="home-new">새 프로젝트</h2>
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
            <button className="home-example" disabled={busy} onClick={onExample}>
              <span className="home-preset-frame">
                <Film size={22} aria-hidden="true" />
              </span>
              <strong>예제 열기</strong>
              <small>사진과 합성 오디오로 둘러보기</small>
            </button>
          </div>
        </section>
        <section aria-labelledby="home-recent">
          <h2 id="home-recent">최근 프로젝트</h2>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          {projects === null ? (
            <p className="home-empty">
              <LoaderCircle className="spin" size={16} /> 프로젝트를 불러오고 있습니다.
            </p>
          ) : !sorted.length ? (
            <p className="home-empty">저장된 프로젝트가 없습니다. 위에서 새 프로젝트를 시작해 보세요.</p>
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
                      <FolderOpen size={22} aria-hidden="true" />
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
                        {when(item.updatedAt)}
                      </small>
                    </div>
                    <div className="home-card-actions">
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
                            <Pencil size={13} />
                          </button>
                          <button title="복제" aria-label={`${item.name} 복제`} onClick={() => void act(item.id, "project.duplicate", { id: item.id })}>
                            <Copy size={13} />
                          </button>
                          <button
                            title={current ? "열려 있는 프로젝트는 삭제할 수 없습니다" : "프로젝트 삭제 · 되돌릴 수 없습니다"}
                            aria-label={`${item.name} 삭제`}
                            disabled={current}
                            onClick={() => setDeleting(item.id)}
                          >
                            <Trash2 size={13} />
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
