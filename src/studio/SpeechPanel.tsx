import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  Check,
  LoaderCircle,
  Mic2,
  RefreshCw,
  Square,
} from "lucide-react";
import { rpc } from "./api";
import { errorText, type ErrorText } from "./errorText";
import type { Command, Project } from "./types";

interface SpeechStatus {
  whisperAvailable: boolean;
  ttsAvailable: boolean;
  voices: { id: string; name: string; language: string }[];
  error?: string;
}
interface SpeechJob {
  id: string;
  state: string;
  progress?: number;
  logs?: ({ text: string } | string)[];
  error?: string;
  output?: string;
  projectId?: string;
  revision?: number;
}
type Operation = "transcribe" | "synthesize";
/** "Eddy (한국어(한국))" with "ko-KR" reads as "Eddy · 한국어". */
export function voiceLabel(voice: { name: string; language: string }) {
  const name = voice.name.replace(/\s*\(.*$/, "").trim() || voice.name;
  const code = voice.language.split(/[-_]/)[0];
  let language = voice.language;
  try {
    language = new Intl.DisplayNames(["ko"], { type: "language" }).of(code) || language;
  } catch {
    // An unknown code is shown as it is.
  }
  return language ? `${name} · ${language}` : name;
}
interface SpeechPanelProps {
  mode: Operation;
  visible: boolean;
  project: Project;
  playhead: number;
  onCommand: Command;
}

export default function SpeechPanel({
  mode,
  visible,
  project,
  playhead,
  onCommand,
}: SpeechPanelProps) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setFailure] = useState<ErrorText | null>(null);
  const setError = (value: unknown) =>
    setFailure(value === "" ? null : errorText(value));
  const [language, setLanguage] = useState("ko");
  const [model, setModel] = useState("base");
  const [translate, setTranslate] = useState(false);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(175);
  const [job, setJob] = useState<SpeechJob | null>(null);
  const [operation, setOperation] = useState<Operation>(mode);
  const refreshedJob = useRef<string | null>(null);
  const probed = useRef(false);
  const active = !!job && ["queued", "running", "cancelling"].includes(job.state);
  const hasAudio = project.clips.some(
    (c) =>
      c.kind === "audio" ||
      project.media.find((m) => m.id === c.mediaId)?.hasAudio,
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await rpc<SpeechStatus>("speech.status");
      setStatus(result);
      setVoice((current) =>
        current && result.voices.some((v) => v.id === current)
          ? current
          : result.voices.find((v) => v.language.startsWith("ko"))?.id ||
            result.voices[0]?.id ||
            "",
      );
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (visible && !probed.current) {
      probed.current = true;
      void refresh();
    }
  }, [visible, refresh]);
  useEffect(() => {
    if (!active || !job) return;
    let disposed = false,
      polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await rpc<SpeechJob>("speech.job", { id: job.id });
        if (disposed) return;
        setJob(next);
        if (next.state === "completed" && refreshedJob.current !== next.id) {
          refreshedJob.current = next.id;
          await onCommand("project.get");
        }
      } catch (e) {
        if (!disposed) setError(e);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 900);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, job?.id, onCommand]);
  const start = async () => {
    setStarting(true);
    setError("");
    setOperation(mode);
    try {
      const next = await rpc<SpeechJob>(
        mode === "transcribe" ? "speech.transcribe" : "speech.synthesize",
        mode === "transcribe"
          ? { language, model, translate }
          : {
              text: text.trim(),
              voice: voice || undefined,
              rate,
              start: playhead,
            },
      );
      setJob({ ...next, state: next.state || "queued" });
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  };
  const cancel = async () => {
    try {
      setJob(await rpc<SpeechJob>("speech.cancel", { id: job!.id }));
    } catch (e) {
      setError(e);
    }
  };
  const unavailable =
    mode === "transcribe" ? !status?.whisperAvailable : !status?.ttsAvailable;

  return (
    <section
      className="speech-panel"
      aria-label={mode === "transcribe" ? "자동 자막" : "텍스트 음성 변환"}
      hidden={!visible}
    >
      <div className="speech-heading">
        <h3>
          {mode === "transcribe" ? <Captions size={15} /> : <Mic2 size={15} />}{" "}
          {mode === "transcribe" ? "자동 자막" : "텍스트 음성 변환"}
        </h3>
        <button
          aria-label="음성 엔진 상태 새로고침"
          disabled={loading || active}
          onClick={() => void refresh()}
        >
          {loading ? (
            <LoaderCircle size={13} className="panel-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
        </button>
      </div>
      {mode === "transcribe" ? (
        <>
          <div className="speech-option-pair">
            <label>
              영상 언어
              <select
                aria-label="자막 언어"
                value={language}
                disabled={active}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="ko">한국어</option>
                <option value="en">영어</option>
                <option value="auto">자동 감지</option>
              </select>
            </label>
            <label>
              인식 모델
              <select
                aria-label="자막 인식 모델"
                value={model}
                disabled={active}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="tiny">Tiny · 빠르게</option>
                <option value="base">Base · 기본</option>
                <option value="small">Small · 정밀하게</option>
              </select>
            </label>
          </div>
          <label className="speech-check">
            <input
              type="checkbox"
              checked={translate}
              disabled={active}
              onChange={(e) => setTranslate(e.target.checked)}
            />
            <span>영어로 번역한 자막 생성</span>
          </label>
          <button
            className="panel-wide-button"
            disabled={active || starting || loading || unavailable || !hasAudio}
            onClick={() => void start()}
          >
            {starting ? (
              <LoaderCircle size={14} className="panel-spin" />
            ) : (
              <Captions size={14} />
            )}
            자동 자막 생성
          </button>
          {!hasAudio && (
            <p className="panel-help">
              음성이 있는 영상이나 오디오를 타임라인에 추가하세요.
            </p>
          )}
          <p className="speech-engine-note">
            로컬 Whisper · 모델을 처음 사용할 때 다운로드가 필요합니다.
          </p>
        </>
      ) : (
        <>
          <textarea
            aria-label="음성으로 만들 텍스트"
            placeholder="여기에 내레이션을 입력하세요."
            value={text}
            disabled={active}
            maxLength={10000}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
          <label className="speech-select-label">
            목소리
            <select
              aria-label="내레이션 목소리"
              disabled={active || !status?.voices.length}
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              {!status?.voices.length && (
                <option value="">
                  {status ? "사용 가능한 목소리 없음" : "목소리 불러오는 중…"}
                </option>
              )}
              {status?.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="speech-rate">
            말하기 속도 <span>{rate} 단어/분</span>
            <input
              aria-label="내레이션 말하기 속도"
              type="range"
              min={80}
              max={300}
              step={5}
              value={rate}
              disabled={active}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </label>
          <button
            className="panel-wide-button"
            disabled={
              active || starting || loading || unavailable || !text.trim()
            }
            onClick={() => void start()}
          >
            {starting ? (
              <LoaderCircle size={14} className="panel-spin" />
            ) : (
              <AudioLines size={14} />
            )}
            음성 생성
          </button>
          <p className="speech-engine-note">
            로컬 시스템 음성 · {playhead.toFixed(2)}초에 추가
          </p>
        </>
      )}
      {status && unavailable && (
        <p className="speech-unavailable">
          {mode === "transcribe"
            ? "로컬 Whisper 실행 환경을 찾지 못했습니다. 음성 인식 환경을 설치한 뒤 상태를 다시 확인해 주세요."
            : "이 컴퓨터에서 사용할 수 있는 시스템 음성 엔진을 찾지 못했습니다."}
        </p>
      )}
      {status?.error && <p className="panel-help">{status.error}</p>}
      {job && (
        <div
          className={`speech-job ${job.state === "failed" ? "failed" : ""}`}
          role="status"
        >
          <div className="speech-job-heading">
            {active ? (
              <LoaderCircle size={14} className="panel-spin" />
            ) : job.state === "completed" ? (
              <Check size={14} />
            ) : (
              <AudioLines size={14} />
            )}
            <strong>
              {active
                ? operation === "transcribe"
                  ? "음성을 인식하고 있습니다"
                  : "음성을 만들고 있습니다"
                : job.state === "completed"
                  ? "타임라인에 추가했습니다"
                  : job.state === "cancelled"
                    ? "작업을 중단했습니다"
                    : "작업을 완료하지 못했습니다"}
            </strong>
            {active && (
              <button aria-label="음성 작업 중단" onClick={() => void cancel()}>
                <Square size={12} />
              </button>
            )}
          </div>
          {active && <progress max={1} value={job.progress || 0} />}
          <div className="speech-logs">
            {job.logs?.slice(-4).map((log, i) => (
              <p key={i}>{typeof log === "string" ? log : log.text}</p>
            ))}
          </div>
          {job.error && <p className="speech-job-error">{job.error}</p>}
          {job.output && (
            <p className="speech-output" title={job.output}>
              {job.output}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="panel-inline-error" role="alert" title={error.detail}>
          {error.message}
        </p>
      )}
    </section>
  );
}
