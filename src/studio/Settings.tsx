import { useEffect, useState } from "react";
import {
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { rpc } from "./api";
import type { Job, RuntimeStatus } from "./types";
import McpSettings from "./McpSettings";

export default function Settings({
  onClose,
  onUpdate,
}: {
  onClose: () => void;
  onUpdate: (s: RuntimeStatus) => void;
}) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [release, setRelease] = useState<{
    installedVersion: string;
    latestVersion: string;
    tag: string;
    url: string;
    updateAvailable: boolean;
  } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
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
  useEffect(() => {
    void refresh();
  }, []);
  const active = job && ["queued", "running"].includes(job.state);
  useEffect(() => {
    if (!active || !job) return;
    const t = setInterval(() => {
      void rpc<Job>("runtime.installStatus", { id: job.id })
        .then((j) => {
          setJob(j);
          if (j.state === "completed") void refresh();
        })
        .catch((e) => setError(String(e)));
    }, 1000);
    return () => clearInterval(t);
  }, [active, job?.id]);
  const check = async () => {
    setBusy(true);
    setError("");
    try {
      setRelease(await rpc("runtime.checkUpdate"));
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
      >
        <header>
          <div>
            <h2 id="settings-heading">Studio 설정</h2>
            <p>편집 엔진, 에이전트, 창작 기억의 연결을 관리합니다.</p>
          </div>
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
              <span
                className={`state-badge ${status?.byoridb.connected ? "online" : ""}`}
              >
                {status?.byoridb.connected
                  ? "연결됨"
                  : status?.byoridb.installed
                    ? "설치됨"
                    : "설치 확인"}
              </span>
            </div>
            <p>컨셉, 편집 결정과 피드백을 다음 작업까지 이어줍니다.</p>
            <dl>
              <dt>설치 버전</dt>
              <dd>{status?.byoridb.version || "확인되지 않음"}</dd>
              <dt>최신 버전</dt>
              <dd>{release?.latestVersion || "아직 확인하지 않음"}</dd>
              <dt>연결</dt>
              <dd>{status?.byoridb.url || "로컬 ByoriDB"}</dd>
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
                disabled={busy || !!active}
                onClick={() => void check()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}{" "}
                최신 버전 확인
              </button>
              {release &&
                (!status?.byoridb.installed || release.updateAvailable) && (
                  <button
                    className="primary-button"
                    disabled={!!active}
                    onClick={() => {
                      setError("");
                      void rpc<Job>("runtime.install", { tag: release.tag })
                        .then(setJob)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    <Download size={14} />
                    {status?.byoridb.installed ? "업데이트" : "설치"}{" "}
                    {release.latestVersion}
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
              <span
                className={`state-badge ${status?.ffmpeg.available ? "online" : ""}`}
              >
                {status?.ffmpeg.available ? "준비됨" : "확인 필요"}
              </span>
            </div>
            <p>
              {status?.ffmpeg.version || "FFmpeg 상태를 확인하고 있습니다."}
            </p>
            <small>{status?.ffmpeg.path}</small>
          </section>
        </div>
        <footer>
          <span>Byori Studio · 로컬 작업 공간</span>
          <button className="secondary-button" onClick={onClose}>
            완료
          </button>
        </footer>
      </section>
    </div>
  );
}
