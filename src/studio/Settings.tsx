import { useEffect, useState } from "react";
import {
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { rpc } from "./api";
import type { Job, RuntimeStatus } from "./types";
import McpSettings from "./McpSettings";
import { useModal } from "./useModal";
import { usePoll } from "./usePoll";
import "./panels.css";

interface Release {
  installedVersion: string;
  latestVersion: string;
  tag: string;
  url: string;
  updateAvailable: boolean;
}
/**
 * Outlives the modal: closing the dialog must not lose a running installation,
 * its last known progress, how it ended, or the release that was checked.
 */
const installation: { job: Job | null; release: Release | null } = {
  job: null,
  release: null,
};
const running = (job: Job | null) =>
  !!job && ["queued", "running"].includes(job.state);
/** For tests: forget the installation kept between dialogs. */
export function resetInstallation() {
  installation.job = null;
  installation.release = null;
}

interface FolderUsage {
  files: number;
  bytes: number;
  cleanable: boolean;
  reclaimableBytes?: number;
  reclaimableFiles?: number;
  removedBytes?: number;
  removedFiles?: number;
}
interface StorageUsage {
  folders: Record<string, FolderUsage>;
  bytes: number;
  reclaimableBytes?: number;
  removedBytes?: number;
  /** Stored projects that still have their default name and nothing in them. Optional: older services do not count them. */
  emptyProjects?: { count: number; bytes?: number; removed?: number };
  /** The most that playback proxies may take, 0 for no limit. Optional: older services have none. */
  proxyLimitBytes?: number;
  /** The open project's proxies alone are over the limit (they are kept). Optional: older services do not tell. */
  proxyOverLimit?: boolean;
}
const GB = 1024 ** 3;
/** The limits offered for playback proxies; 0 is no limit. */
const proxyLimits = [5 * GB, 10 * GB, 20 * GB, 50 * GB, 0];
/** What a cleanup removes: unused scratch files, or the empty default-named projects. */
type CleanTarget = "temporary" | "emptyProjects";
const folderNames: [string, string][] = [
  ["imports", "가져온 소재"],
  ["speech", "음성·자막 생성물"],
  ["proxies", "재생용 프록시"],
  ["previews", "미리보기 프레임"],
  ["renders", "렌더링 임시 파일"],
];
export function byteSize(bytes: number) {
  if (!(bytes > 0)) return "0 MB";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
/** "ffmpeg version 7.1.1 Copyright (c) …" reads as "FFmpeg 7.1.1". */
const ffmpegName = (version?: string) => {
  const number = version?.match(/version\s+(\S+)/i)?.[1] ?? version?.match(/\d+(\.\d+)+\S*/)?.[0];
  return number ? `FFmpeg ${number}` : "FFmpeg";
};
const Checking = () => (
  <span className="settings-checking">
    <LoaderCircle className="spin" size={12} /> 확인 중…
  </span>
);

export default function Settings({
  onClose,
  onUpdate,
}: {
  onClose: () => void;
  onUpdate: (s: RuntimeStatus) => void;
}) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [release, setReleaseState] = useState<Release | null>(installation.release);
  const setRelease = (next: Release) => {
    installation.release = next;
    setReleaseState(next);
  };
  const dialog = useModal<HTMLElement>(onClose);
  // A finished installation was already shown when it ended; only a running one returns.
  const [job, setJobState] = useState<Job | null>(() => {
    if (!running(installation.job)) installation.job = null;
    return installation.job;
  });
  const setJob = (next: Job) => {
    installation.job = next;
    setJobState(next);
  };
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [storageError, setStorageError] = useState("");
  const [confirmClean, setConfirmClean] = useState<CleanTarget | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleaned, setCleaned] = useState<string>("");
  const loadUsage = async () => {
    try {
      const next = await rpc<StorageUsage>("storage.usage");
      if (next?.folders) setUsage(next);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    }
  };
  const clean = async (target: CleanTarget) => {
    setCleaning(true);
    setStorageError("");
    try {
      if (target === "emptyProjects") {
        const asked = usage?.emptyProjects?.count ?? 0;
        const result = await rpc<StorageUsage>("storage.clean", { targets: ["emptyProjects"] });
        setCleaned(`빈 프로젝트 ${result?.emptyProjects?.removed ?? asked}개를 삭제했습니다`);
      } else {
        const result = await rpc<StorageUsage>("storage.clean");
        setCleaned(result?.folders ? `${byteSize(result.removedBytes ?? 0)}를 정리했습니다` : "");
      }
      setConfirmClean(null);
      await loadUsage();
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    } finally {
      setCleaning(false);
    }
  };
  const emptyProjects = usage?.emptyProjects?.count ?? 0;
  /** The service keeps the proxies within the limit from then on; it answers with the usage. */
  const setProxyLimit = async (proxyLimitBytes: number) => {
    setStorageError("");
    try {
      const next = await rpc<StorageUsage>("storage.configure", { proxyLimitBytes });
      if (next?.folders) setUsage(next);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const s = await rpc<RuntimeStatus>("runtime.status");
      setStatus(s);
      onUpdate(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const showJob = (next: Job) => {
    setJob(next);
    if (next.state === "completed") void refresh();
  };
  useEffect(() => {
    void refresh();
    void loadUsage();
    // A job that was running when the dialog closed may have moved on since.
    const kept = installation.job;
    if (running(kept))
      void rpc<Job>("runtime.installStatus", { id: kept!.id })
        .then((next) => {
          if (installation.job?.id === kept!.id) showJob(next);
        })
        .catch(() => {
          // Polling below reports a status that stays unreachable.
        });
  }, []);
  const active = running(job);
  const poll = usePoll(
    active ? job!.id : null,
    async () => showJob(await rpc<Job>("runtime.installStatus", { id: job!.id })),
    1000,
  );
  const check = async () => {
    setBusy(true);
    setError("");
    try {
      setRelease(await rpc<Release>("runtime.checkUpdate"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setBusy(true);
    setError("");
    try {
      const target = release ?? (await rpc<Release>("runtime.checkUpdate"));
      setRelease(target);
      const started = await rpc<Job>("runtime.install", { tag: target.tag });
      setJob({ ...started, state: started.state || "running" });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
        tabIndex={-1}
        ref={dialog}
      >
        <header>
          <h2 id="settings-heading">Studio 설정</h2>
          <button title="설정 닫기" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="settings-body">
          <section>
            <div className="section-heading">
              <h3>ByoriDB</h3>
              {status && (
                <span
                  className={`state-badge ${status.byoridb.connected ? "online" : ""}`}
                >
                  {status.byoridb.connected
                    ? "연결됨"
                    : status.byoridb.installed
                      ? "설치됨"
                      : "미설치"}
                </span>
              )}
            </div>
            <p>컨셉, 편집 결정과 피드백을 다음 작업까지 이어줍니다.</p>
            <dl>
              <dt>설치 버전</dt>
              <dd>
                {status ? status.byoridb.version || "설치되지 않음" : <Checking />}
              </dd>
              <dt>최신 버전</dt>
              <dd>{release?.latestVersion || "확인하지 않음"}</dd>
              <dt>연결</dt>
              <dd>
                {status ? status.byoridb.url || "로컬 ByoriDB" : <Checking />}
              </dd>
            </dl>
            {status?.byoridb.error && (
              <p className="status-detail">{status.byoridb.error}</p>
            )}
            <div className="settings-actions">
              {status?.byoridb.installed && !status.byoridb.running && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void rpc("runtime.start")
                      .then(refresh)
                      .catch((e) => setError(String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  ByoriDB 시작
                </button>
              )}
              <button
                className="secondary-button"
                disabled={busy || active}
                onClick={() => void check()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}{" "}
                최신 버전 확인
              </button>
              {status &&
                (!status.byoridb.installed || release?.updateAvailable) && (
                  <button
                    className="primary-button"
                    disabled={busy || active}
                    onClick={() => void install()}
                  >
                    <Download size={14} />
                    {status.byoridb.installed ? "업데이트" : "ByoriDB 설치"}{" "}
                    {release?.latestVersion}
                  </button>
                )}
              {release &&
                status?.byoridb.installed &&
                !release.updateAvailable &&
                release.installedVersion?.replace(/^v/, "") ===
                  release.latestVersion?.replace(/^v/, "") && (
                  <span className="up-to-date">
                    <Check size={14} /> 최신 버전
                  </span>
                )}
              {release?.url && (
                <a href={release.url} target="_blank" rel="noreferrer">
                  릴리스 노트 <ExternalLink size={12} />
                </a>
              )}
            </div>
            {job && (
              <div className="installation-job">
                <strong>
                  {active
                    ? "설치 진행 중"
                    : job.state === "completed"
                      ? "설치 완료"
                      : job.state === "failed"
                        ? "설치 실패"
                        : job.state}
                </strong>
                {typeof job.progress === "number" && (
                  <progress value={job.progress} max={1} />
                )}
                <pre>
                  {job.logs
                    ?.map((l) => (typeof l === "string" ? l : l.text))
                    .join("\n")}
                </pre>
                {job.error && <p className="inline-error">{job.error}</p>}
                {poll.stalled && (
                  <p className="inline-error" role="alert">
                    설치 상태를 확인하지 못했습니다. {poll.error}{" "}
                    <button onClick={poll.retry}>다시 시도</button>
                  </p>
                )}
              </div>
            )}
          </section>
          <section>
            <div className="section-heading">
              <h3>편집 에이전트</h3>
              <button title="연결 상태 새로고침" onClick={() => void refresh()}>
                <RefreshCw size={14} />
              </button>
            </div>
            <p>설치된 CLI와 기존 로그인 환경을 사용합니다.</p>
            {!status && <Checking />}
            <div className="provider-list">
              {status?.providers.map((p) => (
                <div key={p.id}>
                  <span
                    className={`status-dot ${p.available ? "online" : ""}`}
                  />
                  <div>
                    <strong>{p.name}</strong>
                    <small>
                      {p.version || p.path || "실행 파일을 찾을 수 없습니다"}
                    </small>
                  </div>
                  <span className="state-badge">
                    {!p.available
                      ? "미설치"
                      : p.authStatus === "missing"
                        ? "로그인 필요"
                        : p.authStatus === "authenticated"
                          ? "로그인됨"
                          : "설치됨"}
                  </span>
                </div>
              ))}
            </div>
            <p className="status-detail">
              로그인이 필요하면 해당 CLI에서 로그인한 뒤 상태를 새로고침하세요.
            </p>
          </section>
          <McpSettings />
          <section>
            <div className="section-heading">
              <h3>미디어 엔진</h3>
              {status && (
                <span
                  className={`state-badge ${status.ffmpeg.available ? "online" : ""}`}
                >
                  {status.ffmpeg.available ? "준비됨" : "설치 필요"}
                </span>
              )}
            </div>
            <p title={status?.ffmpeg.path}>
              {!status ? (
                <Checking />
              ) : status.ffmpeg.available ? (
                ffmpegName(status.ffmpeg.version)
              ) : (
                "FFmpeg를 찾을 수 없습니다. 설치한 뒤 설정을 다시 열어 주세요."
              )}
            </p>
          </section>
          {(usage || storageError) && (
            <section aria-labelledby="storage-heading">
              <div className="section-heading">
                <h3 id="storage-heading">저장 공간</h3>
                {usage && <span className="state-badge">{byteSize(usage.bytes)}</span>}
              </div>
              {usage && (
                <dl>
                  {folderNames.map(
                    ([id, name]) =>
                      usage.folders[id] && (
                        <div className="storage-row" key={id}>
                          <dt>{name}</dt>
                          <dd>{byteSize(usage.folders[id].bytes)}</dd>
                        </div>
                      ),
                  )}
                  {emptyProjects > 0 && (
                    <div className="storage-row">
                      <dt>빈 프로젝트</dt>
                      <dd>{emptyProjects}개</dd>
                    </div>
                  )}
                </dl>
              )}
              {usage?.proxyLimitBytes !== undefined && (
                <label className="storage-limit">
                  프록시 한도
                  <select
                    value={usage.proxyLimitBytes}
                    disabled={cleaning}
                    onChange={(e) => void setProxyLimit(Number(e.target.value))}
                  >
                    {Array.from(new Set([...proxyLimits, usage.proxyLimitBytes]))
                      .sort((a, b) => (a || Infinity) - (b || Infinity))
                      .map((bytes) => (
                        <option key={bytes} value={bytes}>
                          {!bytes
                            ? "제한 없음"
                            : bytes % GB
                              ? byteSize(bytes)
                              : `${bytes / GB} GB`}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {usage?.proxyOverLimit === true && (
                <p className="status-detail">
                  열린 프로젝트의 프록시가 한도를 넘었습니다. 열린 프로젝트의 프록시는 지워지지 않습니다.
                </p>
              )}
              {usage && (
                <div className="settings-actions">
                  {confirmClean ? (
                    <>
                      <span
                        className="storage-confirm"
                        // The question and its two buttons open below the fold.
                        ref={(node) => node?.parentElement?.scrollIntoView?.({ block: "nearest" })}
                      >
                        {confirmClean === "emptyProjects" ? (
                          <>
                            이름을 바꾸지 않았고 아무것도 넣지 않은 프로젝트{" "}
                            {emptyProjects}개를 삭제합니다. 되돌릴 수 없습니다.
                          </>
                        ) : (
                          <>
                            쓰이지 않는 프록시·미리보기·렌더링 임시 파일{" "}
                            {byteSize(usage.reclaimableBytes ?? 0)}를 삭제합니다. 원본
                            소재와 프로젝트는 지우지 않습니다.
                          </>
                        )}
                      </span>
                      <button
                        className="primary-button"
                        disabled={cleaning}
                        onClick={() => void clean(confirmClean)}
                      >
                        {cleaning ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Trash2 size={14} />
                        )}{" "}
                        삭제
                      </button>
                      <button
                        className="secondary-button"
                        disabled={cleaning}
                        onClick={() => setConfirmClean(null)}
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="secondary-button"
                        disabled={!(usage.reclaimableBytes! > 0)}
                        onClick={() => {
                          setCleaned("");
                          setConfirmClean("temporary");
                        }}
                      >
                        <Trash2 size={14} /> 쓰지 않는 임시 파일 정리
                        {usage.reclaimableBytes! > 0
                          ? ` (${byteSize(usage.reclaimableBytes!)})`
                          : ""}
                      </button>
                      {emptyProjects > 0 && (
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setCleaned("");
                            setConfirmClean("emptyProjects");
                          }}
                        >
                          <Trash2 size={14} /> 빈 프로젝트 {emptyProjects}개 삭제
                        </button>
                      )}
                    </>
                  )}
                  {!confirmClean && cleaned && (
                    <span className="up-to-date" role="status">
                      <Check size={14} /> {cleaned}
                    </span>
                  )}
                  {!confirmClean && !cleaned && !(usage.reclaimableBytes! > 0) && (
                    <span className="status-detail">정리할 임시 파일이 없습니다.</span>
                  )}
                </div>
              )}
              {storageError && (
                <p className="inline-error" role="alert">
                  저장 공간을 확인하지 못했습니다. {storageError}
                </p>
              )}
            </section>
          )}
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>
            완료
          </button>
        </footer>
      </section>
    </div>
  );
}
