import { useEffect, useState } from "react";
import { Check, ExternalLink, Link2, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { rpc } from "./api";
import "./mcp-settings.css";

interface McpStatus {
  added: boolean;
  enabled: boolean;
  phase: "unchecked" | "connecting" | "cancelling" | "connected" | "failed" | "cancelled";
  url: string;
  toolCount: number;
  /** The Higgsfield tools the agents are actually given. */
  allowedTools?: string[];
  checkedAt?: number | null;
  error?: string | null;
  bridgeAvailable: boolean;
}

export default function McpSettings() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = status?.phase === "connecting" || status?.phase === "cancelling";
  useEffect(() => {
    let live = true;
    void rpc<McpStatus>("runtime.mcpGet").then(s => { if (live) setStatus(s); }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void rpc<McpStatus>("runtime.mcpStatus")
        .then(s => { if (live) setStatus(s); })
        .catch(e => { if (live) setError(String(e)); })
        .finally(() => { pending = false; });
    }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);
  const run = async (method: string, params: Record<string, unknown> = {}) => {
    setBusy(true); setError("");
    try { setStatus(await rpc<McpStatus>(method, params)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const label = !status ? "" : !status.added ? "미연결" : !status.enabled ? "꺼짐" : active ? "연결 확인 중" : status.phase === "connected" ? "연결 확인됨" : "연결 확인 필요";
  return <section className="mcp-settings" aria-labelledby="higgsfield-heading">
    <div className="section-heading">
      <h3 id="higgsfield-heading">Higgsfield MCP</h3>
      {status && <span className={`state-badge ${status.enabled && status.phase === "connected" ? "online" : ""}`}>{label}</span>}
    </div>
    <p>편집 에이전트에서 Higgsfield의 모델과 크레딧을 조회합니다.</p>
    <div className="mcp-endpoint"><Link2 size={13} /><span>{status?.url || "https://mcp.higgsfield.ai/mcp"}</span></div>
    {status?.added ? <>
      <label className="mcp-toggle">
        <input type="checkbox" checked={status.enabled} disabled={busy || active} onChange={e => void run("runtime.mcpSave", { enabled: e.target.checked })} />
        Claude Code · Codex · Gemini CLI에서 사용
      </label>
      <div className="mcp-actions">
        <button className="secondary-button" disabled={busy || active || !status.bridgeAvailable} onClick={() => void run("runtime.mcpConnect")}>
          {active ? <LoaderCircle className="spin" size={14} /> : <Link2 size={14} />}
          로그인·연결 확인
        </button>
        {active ? <button disabled={busy || status.phase === "cancelling"} onClick={() => void run("runtime.mcpCancel")}>연결 취소</button>
          : <button className="mcp-remove" disabled={busy} onClick={() => void run("runtime.mcpRemove")}><Trash2 size={13} /> 연결 삭제</button>}
      </div>
      {active && <p className="mcp-progress" role="status">브라우저에서 Higgsfield 로그인을 완료해주세요. 첫 연결은 연결 구성요소를 준비하는 시간이 필요합니다.</p>}
      {status.phase === "connected" && <p className="mcp-connected" role="status"><Check size={13} /> 도구 {status.toolCount}개 확인 · {status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "방금"}</p>}
      {status.phase === "connected" && status.allowedTools?.length === 0 && <p className="inline-error" role="alert">연결됐지만 에이전트가 쓸 수 있는 Higgsfield 도구가 없습니다. 서버의 도구 이름이 바뀌었을 수 있습니다.</p>}
      <p className="status-detail">변경 사항은 다음 에이전트 작업부터 적용됩니다. 연결 삭제 시 Studio에 저장된 로그인도 지웁니다.</p>
    </> : <button className="secondary-button" disabled={busy || !status} onClick={() => void run("runtime.mcpSave", { enabled: true })}><Plus size={14} /> Higgsfield 추가</button>}
    {status && !status.bridgeAvailable && <p className="inline-error">연결하려면 Node.js와 npx를 설치해주세요.</p>}
    {(error || status?.error) && <p className="inline-error" role="alert">{error || status?.error}</p>}
    <p className="status-detail">모델·크레딧 조회만 지원합니다. <a href="https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent" target="_blank" rel="noreferrer">연결 안내 <ExternalLink size={11} /></a></p>
  </section>;
}
