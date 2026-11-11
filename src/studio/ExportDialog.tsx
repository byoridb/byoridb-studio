import { useEffect, useState } from "react";
import { Download, FolderOpen, LoaderCircle, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { assetUrl, rpc, savePath } from "./api";
import { durationOf, type Job, type Project } from "./types";
export default function ExportDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [format, setFormat] = useState("mp4");
  const [path, setPath] = useState(
    `~/Movies/Byori Studio/${project.name.replace(/[\\/:*?"<>|]/g, "_")}.mp4`,
  );
  const [height, setHeight] = useState(project.height);
  const [fps, setFps] = useState(project.fps);
  const [quality, setQuality] = useState(18);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(durationOf(project));
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    let stale = false;
    setPreview("");
    setPreviewError(false);
    const timer = setTimeout(() => {
      void rpc<{ assetId: string }>(
        "preview.frame",
        { time: range ? startTime : 0, width: 640 },
        project.id,
      )
        .then((result) => {
          if (!stale && result.assetId) setPreview(assetUrl(result.assetId));
        })
        .catch(() => {
          if (!stale) setPreviewError(true);
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [project.id, project.revision, range, startTime]);
  const active = job && ["queued", "running", "cancelling"].includes(job.state);
  useEffect(() => {
    if (!active || !job) return;
    const t = setInterval(() => {
      void rpc<Job>("export.status", { id: job.id })
        .then(setJob)
        .catch((e) => setError(String(e)));
    }, 500);
    return () => clearInterval(t);
  }, [active, job?.id]);
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      if (
        range &&
        !(
          startTime >= 0 &&
          endTime > startTime &&
          endTime <= durationOf(project)
        )
      )
        throw new Error("내보낼 구간의 시작과 끝을 확인하세요.");
      const j = await rpc<{ id: string }>(
        "export.start",
        {
          path,
          format,
          width:
            Math.round(((project.width / project.height) * height) / 2) * 2,
          height,
          fps,
          crf: quality,
          ...(range ? { start: startTime, end: endTime } : {}),
        },
        project.id,
      );
      setJob({ id: j.id, state: "running", progress: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
      >
        <header>
          <div>
            <h2 id="export-title">내보내기</h2>
            <p>마지막 프레임까지, 의도한 그대로.</p>
          </div>
          <button
            title={
              active
                ? "내보내기가 끝나거나 취소되면 닫을 수 있습니다"
                : "내보내기 닫기"
            }
            disabled={!!active || busy}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <div className="export-body">
          <div className="export-preview">
            {preview ? (
              <img
                src={preview}
                alt="실제 합성 결과 미리보기"
                style={{
                  aspectRatio: `${project.width}/${project.height}`,
                  objectFit: "contain",
                  background: project.background,
                }}
              />
            ) : (
              <div
                className="export-frame-placeholder"
                style={{
                  aspectRatio: `${project.width}/${project.height}`,
                  display: "grid",
                  placeItems: "center",
                  background: "#111",
                  color: "#b9c0ca",
                  fontSize: 11,
                }}
              >
                {previewError
                  ? "합성 미리보기를 불러오지 못했습니다"
                  : "합성 프레임 준비 중…"}
              </div>
            )}
            <span>{project.name}</span>
            <small>
              {durationOf(project).toFixed(2)}초 · {project.clips.length}개 클립
            </small>
          </div>
          <div className="export-options">
            <label>
              저장 위치
              <div className="path-field">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  disabled={!!active}
                />
                {isTauri() && (
                  <button
                    title="저장 위치 선택"
                    disabled={!!active || busy}
                    onClick={() => {
                      void savePath(`${project.name}.${format}`, format).then(
                        (p) => {
                          if (p) setPath(p);
                        },
                      );
                    }}
                  >
                    <FolderOpen size={16} />
                  </button>
                )}
              </div>
            </label>
            <label>
              형식
              <select
                disabled={!!active}
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setPath(path.replace(/\.[^.]+$/, `.${e.target.value}`));
                }}
              >
                {["mp4", "mov", "webm", "mp3", "wav"].map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              해상도
              <select
                disabled={!!active}
                value={height}
                onChange={(e) => setHeight(+e.target.value)}
              >
                {Array.from(new Set([720, 1080, 1440, 2160, project.height]))
                  .sort((a, b) => a - b)
                  .map((h) => (
                    <option key={h} value={h}>
                      {h}p{h === project.height ? " · 프로젝트" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              프레임레이트
              <select
                disabled={!!active}
                value={fps}
                onChange={(e) => setFps(+e.target.value)}
              >
                {[24, 25, 30, 50, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <label>
              품질
              <select
                disabled={!!active}
                value={quality}
                onChange={(e) => setQuality(+e.target.value)}
              >
                <option value={18}>높음</option>
                <option value={23}>권장</option>
                <option value={28}>작은 파일</option>
              </select>
            </label>
            <label>
              내보낼 구간
              <select
                disabled={!!active}
                value={range ? "range" : "all"}
                onChange={(e) => setRange(e.target.value === "range")}
              >
                <option value="all">전체 타임라인</option>
                <option value="range">구간 지정</option>
              </select>
            </label>
            {range && (
              <div className="export-range">
                <label>
                  시작 (초)
                  <input
                    type="number"
                    min={0}
                    max={durationOf(project)}
                    step={0.1}
                    value={startTime}
                    disabled={!!active}
                    onChange={(e) => setStartTime(+e.target.value)}
                  />
                </label>
                <label>
                  끝 (초)
                  <input
                    type="number"
                    min={0}
                    max={durationOf(project)}
                    step={0.1}
                    value={endTime}
                    disabled={!!active}
                    onChange={(e) => setEndTime(+e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
        {error && <div className="inline-error">{error}</div>}
        {job && (
          <div className="export-progress">
            <div>
              <strong>
                {job.state === "completed"
                  ? "내보내기 완료"
                  : job.state === "failed"
                    ? "내보내기 실패"
                    : job.state === "cancelled"
                      ? "내보내기 취소"
                      : job.state === "cancelling"
                        ? "내보내기를 취소하고 있습니다"
                        : "영상을 내보내고 있습니다"}
              </strong>
              <span>{Math.round((job.progress || 0) * 100)}%</span>
            </div>
            <progress value={job.progress || 0} max={1} />
            {job.path && <p>{job.path}</p>}
            {job.error && <p className="inline-error">{job.error}</p>}
          </div>
        )}
        <footer>
          <span>원본 소재는 변경되지 않습니다.</span>
          {active ? (
            <button
              className="secondary-button"
              disabled={job?.state === "cancelling"}
              onClick={() =>
                void rpc<Job>("export.cancel", { id: job!.id })
                  .then(setJob)
                  .catch((e) => setError(String(e)))
              }
            >
              내보내기 취소
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={busy || !path.trim()}
              onClick={() => void start()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Download size={15} />
              )}{" "}
              {job?.state === "completed" ? "다시 내보내기" : "내보내기"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
