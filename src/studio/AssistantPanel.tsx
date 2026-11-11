import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  History,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Square,
  X,
} from "lucide-react";
import type {
  AgentSummary,
  Clip,
  Command,
  Job,
  Note,
  Project,
  RuntimeStatus,
} from "./types";
import { rpc } from "./api";
import { usePoll } from "./usePoll";
import "./panels.css";

interface Props {
  project: Project;
  selected: Clip | null;
  onCommand: Command;
  onClose: () => void;
  onSettings: () => void;
  runtime: RuntimeStatus | null;
}
const activeStates = ["queued", "running", "cancelling"];
type ConceptKey = keyof Project["concept"];
/** The job last shown, so a reopened panel can show how it ended. */
let lastJob: { projectId: string; id: string } | null = null;

export default function AssistantPanel(props: Props) {
  return <Panel key={props.project.id} {...props} />;
}

function Panel({
  project,
  selected,
  onCommand,
  onClose,
  onSettings,
  runtime: runtimeProp,
}: Props) {
  const [tab, setTab] = useState("assistant");
  const [prompt, setPrompt] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobProvider, setJobProvider] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<Partial<Project["concept"]>>({});
  const [ownRuntime, setOwnRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const runtime = runtimeProp ?? ownRuntime;
  const loadRuntime = useCallback(() => {
    setRuntimeFailed(false);
    void rpc<RuntimeStatus>("runtime.status")
      .then(setOwnRuntime)
      .catch(() => setRuntimeFailed(true));
  }, []);
  useEffect(() => {
    if (!runtimeProp) loadRuntime();
  }, [!runtimeProp, loadRuntime]);
  const providers = runtime?.providers ?? [];
  const provider =
    (chosen && providers.some((p) => p.id === chosen && p.available)
      ? chosen
      : (
          providers.find((p) => p.available && p.authStatus !== "missing") ??
          providers.find((p) => p.available)
        )?.id) ?? "";
  const current = providers.find((p) => p.id === provider);
  const providerName = (id: string) =>
    providers.find((p) => p.id === id)?.name ?? id;
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await rpc<AgentSummary[]>("agent.list");
        const mine = Array.isArray(list)
          ? list.filter((j) => j.projectId === project.id)
          : [];
        const target =
          mine.find((j) => activeStates.includes(j.state)) ??
          mine.find(
            (j) => lastJob?.projectId === project.id && j.id === lastJob.id,
          );
        if (!target) return;
        const full = await rpc<Job>("agent.status", { id: target.id });
        if (!live) return;
        setJob((existing) => existing ?? full);
        setJobProvider((existing) => existing || target.provider);
      } catch {
        // Reattaching is best effort; a new request still works without it.
      }
    })();
    return () => {
      live = false;
    };
  }, [project.id]);
  const active = !!job && activeStates.includes(job.state);
  const poll = usePoll(
    active ? job.id : null,
    async () => {
      const id = job!.id;
      const next = await rpc<Job>("agent.status", { id });
      setJob((existing) => (existing?.id === id ? next : existing));
    },
    800,
  );
  useEffect(() => {
    if (!active) setCancelling(false);
  }, [active]);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [job?.logs?.length]);
  const start = async () => {
    if (!prompt.trim() || !provider) return;
    setBusy(true);
    setError("");
    try {
      const result = await rpc<{ id: string }>("agent.start", {
        provider,
        prompt: prompt.trim(),
        projectId: project.id,
        clipId: selected?.id,
      });
      setJob({ id: result.id, state: "running", logs: [] });
      setJobProvider(provider);
      lastJob = { projectId: project.id, id: result.id };
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const findMemory = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await rpc<{ items: Note[] }>("memory.search", {
        text: search,
        limit: 20,
      });
      setNotes(result.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remember = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await rpc<Note>("memory.record", {
        body: note,
        kind: "feedback",
        clipId: selected?.id,
        projectId: project.id,
      });
      setNotes((v) => [saved, ...v]);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setCancelling(true);
    void rpc<Job>("agent.cancel", { id: job!.id })
      .then((next) => {
        if (next?.state) setJob(next);
      })
      .catch((e) => {
        setCancelling(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  const saveConcept = (key: ConceptKey) => {
    const value = draft[key];
    const settle = () =>
      setDraft((d) => {
        if (d[key] !== value) return d;
        const { [key]: _saved, ...rest } = d;
        return rest;
      });
    if (value === undefined) return;
    if (value === project.concept[key]) return settle();
    void onCommand("project.update", {
      patch: { concept: { ...project.concept, [key]: value } },
    })
      .then(settle)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <aside className="assistant-panel" aria-label="편집 어시스턴트">
      <div className="panel-heading">
        <span className="assistant-brand">
          <span className="byori-mark small">b</span> Byori Assistant
        </span>
        <button title="어시스턴트 닫기" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="assistant-tabs">
        <button
          className={tab === "assistant" ? "selected" : ""}
          onClick={() => setTab("assistant")}
        >
          <MessageSquare size={14} /> 편집
        </button>
        <button
          className={tab === "brief" ? "selected" : ""}
          onClick={() => setTab("brief")}
        >
          <Lightbulb size={14} /> 컨셉
        </button>
        <button
          className={tab === "memory" ? "selected" : ""}
          onClick={() => setTab("memory")}
        >
          <BookOpen size={14} /> 기억
        </button>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="오류 닫기">
            <X size={12} />
          </button>
        </div>
      )}
      {tab === "assistant" && (
        <>
          <div className="assistant-feed" ref={feed}>
            {!job && (
              <div className="assistant-intro">
                <div className="assistant-orbit">
                  <span className="byori-mark">b</span>
                </div>
                <h2>
                  함께 만드는,
                  <br />더 나은 다음 장면.
                </h2>
                <p>
                  원하는 편집을 말해 주세요.
                  <br />이 프로젝트의 맥락과 기억을 이어서 작업합니다.
                </p>
                <div className="suggestion-list">
                  {[
                    "현재 영상의 흐름을 살펴보고 편집 방향을 제안해줘",
                    "도입부를 더 짧고 인상적으로 다듬어줘",
                    "기존 피드백을 찾아 이번 영상에 반영해줘",
                  ].map((s) => (
                    <button key={s} onClick={() => setPrompt(s)}>
                      {s}
                      <Plus size={13} />
                    </button>
                  ))}
                </div>
                <span className="agent-explanation">
                  선택한 CLI가 Studio의 편집 도구를 사용합니다.
                </span>
              </div>
            )}
            {job && (
              <div className="agent-run">
                <div className="agent-run-heading">
                  {active ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : job.state === "completed" ? (
                    <Check size={16} />
                  ) : (
                    <Circle size={14} />
                  )}
                  <strong>
                    {cancelling && active
                      ? "작업을 중단하는 중"
                      : active
                      ? "편집 작업 진행 중"
                      : job.state === "completed"
                        ? "작업 완료"
                        : job.state === "cancelled"
                          ? "작업 중단"
                          : "작업 결과"}
                  </strong>
                  <span>{providerName(jobProvider || job.provider || "")}</span>
                </div>
                <div className="agent-logs">
                  {job.logs?.map((log, i) => (
                    <p key={i}>{typeof log === "string" ? log : log.text}</p>
                  ))}
                </div>
                {job.result && <p className="agent-result">{job.result}</p>}
                {job.error && <div className="inline-error">{job.error}</div>}
                {poll.stalled && (
                  <div className="inline-error" role="alert">
                    작업 상태를 확인하지 못했습니다. {poll.error}
                    <button onClick={poll.retry}>다시 시도</button>
                  </div>
                )}
                {!active && (
                  <button
                    className="subtle-button"
                    onClick={() => {
                      lastJob = null;
                      setJob(null);
                      setJobProvider("");
                    }}
                  >
                    <Plus size={14} /> 새 작업
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="assistant-compose">
            {selected && (
              <div className="context-chip">
                <span />
                선택한 클립: {selected.name}
              </div>
            )}
            <textarea
              aria-label="편집 요청"
              placeholder="어떤 영상을 만들까요?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void start();
                }
              }}
            />
            {!runtime && (
              <p className="assistant-provider-note" role="status">
                {runtimeFailed
                  ? "에이전트 상태를 확인하지 못했습니다."
                  : "에이전트 상태를 확인하는 중…"}
                {runtimeFailed && (
                  <button onClick={loadRuntime}>다시 확인</button>
                )}
              </p>
            )}
            {runtime && !provider && (
              <p className="assistant-provider-note" role="status">
                사용할 수 있는 편집 에이전트 CLI가 없습니다.
                <button onClick={onSettings}>설정</button>
              </p>
            )}
            {current?.authStatus === "missing" && (
              <p className="assistant-provider-note" role="status">
                {current.name} 로그인이 필요합니다. CLI에서 로그인한 뒤 상태를
                새로고침하세요.
                <button onClick={onSettings}>설정</button>
              </p>
            )}
            <div className="compose-toolbar">
              <label className="provider-select">
                <span className="provider-dot" />
                <select
                  aria-label="편집 에이전트"
                  value={provider}
                  onChange={(e) => setChosen(e.target.value)}
                  disabled={active || !providers.length}
                >
                  {!provider && <option value="">사용 불가</option>}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.name}
                      {!p.available
                        ? " · 미설치"
                        : p.authStatus === "missing"
                          ? " · 로그인 필요"
                          : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </label>
              {active ? (
                <button
                  className="send-button stop"
                  title="작업 중단"
                  disabled={cancelling}
                  onClick={cancel}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  title="편집 요청 보내기 (⌘Enter)"
                  disabled={!prompt.trim() || busy || !provider}
                  onClick={() => void start()}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowUp size={17} />
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="assistant-footnote">
            변경 내용은 타임라인에 반영되며 실행 취소할 수 있습니다.
          </div>
        </>
      )}
      {tab === "brief" && (
        <div className="brief-editor">
          <h3>이 영상의 방향</h3>
          <p>사람과 에이전트가 함께 참고할 창작 브리프입니다.</p>
          {(
            [
              ["audience", "누구에게", "이 영상을 보는 사람"],
              ["message", "전달할 메시지", "보고 난 뒤 남기고 싶은 한 가지"],
              ["appeal", "소구점", "시선을 붙잡을 이유"],
              ["direction", "편집 방향", "리듬, 톤, 장면 구성"],
            ] as const
          ).map(([key, label, placeholder]) => (
            <label key={key}>
              {label}
              <textarea
                value={draft[key] ?? project.concept[key]}
                placeholder={placeholder}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                onBlur={() => saveConcept(key)}
              />
            </label>
          ))}
          <div className="brief-note">
            <Lightbulb size={15} />
            <span>
              방향을 바꾸게 된 이유는 ‘기억’에 남겨 다음 편집으로 이어가세요.
            </span>
          </div>
        </div>
      )}
      {tab === "memory" && (
        <div className="memory-panel">
          <div className="memory-status">
            <span
              className={`status-dot ${runtime?.byoridb.connected ? "online" : ""}`}
            />
            {runtime?.byoridb.connected
              ? "ByoriDB 연결됨"
              : "ByoriDB 연결 필요"}
            <button onClick={onSettings}>설정</button>
          </div>
          <h3>다음 편집을 위한 기억</h3>
          <div className="memory-search">
            <Search size={14} />
            <input
              aria-label="기억 검색"
              placeholder="컨셉, 피드백 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void findMemory();
              }}
            />
            <button title="검색" onClick={() => void findMemory()}>
              <ArrowUp size={15} />
            </button>
          </div>
          <div className="memory-list">
            {notes.length ? (
              notes.map((n, i) => (
                <article key={n.id || i}>
                  <div>
                    <History size={13} />
                    <span>{n.kind || "피드백"}</span>
                  </div>
                  <p>{n.body}</p>
                </article>
              ))
            ) : (
              <div className="memory-empty">
                <BookOpen size={24} />
                <p>편집의 이유를 남겨두세요.</p>
                <span>필요할 때 검색해서 다음 작업에 활용할 수 있습니다.</span>
              </div>
            )}
          </div>
          <textarea
            aria-label="피드백 기록"
            placeholder="왜 이렇게 편집했나요? 다음에는 무엇을 바꿀까요?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="primary-button"
            disabled={busy || !note.trim()}
            onClick={() => void remember()}
          >
            <Plus size={14} /> ByoriDB에 기억하기
          </button>
        </div>
      )}
    </aside>
  );
}
