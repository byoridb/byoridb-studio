import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AssistantPanel from "./AssistantPanel";
import { rpc } from "./api";
import type { Project, RuntimeStatus } from "./types";

vi.mock("./api", () => ({ rpc: vi.fn() }));

const project: Project = {
  id: "p1",
  name: "여행",
  revision: 3,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  media: [],
  tracks: [],
  clips: [],
  markers: [],
  concept: { audience: "여행자", message: "", appeal: "", direction: "" },
  notes: [],
  updatedAt: 0,
};
const runtime: RuntimeStatus = {
  ffmpeg: { available: true },
  providers: [
    { id: "claude", name: "Claude Code", available: false },
    { id: "codex", name: "Codex", available: true, authStatus: "missing" },
    { id: "gemini", name: "Gemini CLI", available: true },
  ],
  byoridb: { installed: true, running: true, connected: true },
};
type Handler = (params: Record<string, unknown>) => unknown;
const serve = (handlers: Record<string, Handler>) =>
  vi.mocked(rpc).mockImplementation(async (method, params = {}) => {
    if (!(method in handlers)) return [];
    return handlers[method](params);
  });
const panel = (overrides: Partial<Parameters<typeof AssistantPanel>[0]> = {}) => (
  <AssistantPanel
    project={project}
    selected={null}
    onCommand={vi.fn().mockResolvedValue(project)}
    onClose={vi.fn()}
    onSettings={vi.fn()}
    runtime={runtime}
    {...overrides}
  />
);
const calls = (method: string) =>
  vi.mocked(rpc).mock.calls.filter(([name]) => name === method);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("AssistantPanel", () => {
  it("reattaches to the running job of this project after being reopened", async () => {
    serve({
      "agent.list": () => [
        { id: "other", provider: "codex", state: "running", projectId: "p2", startedAt: 2 },
        { id: "job1", provider: "gemini", state: "running", projectId: "p1", startedAt: 1 },
      ],
      "agent.status": ({ id }) => ({
        id,
        state: "running",
        logs: [{ at: "", stream: "stdout", text: "도입부를 다듬는 중" }],
      }),
    });
    const { unmount } = render(panel());
    expect(await screen.findByText("도입부를 다듬는 중")).toBeInTheDocument();
    expect(screen.getByText("편집 작업 진행 중")).toBeInTheDocument();
    expect(screen.getByText("Gemini CLI", { selector: "span" })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("agent.status", { id: "job1" });
    unmount();
    render(panel());
    expect(await screen.findByTitle("작업 중단")).toBeEnabled();
  });

  it("keeps polling after cancel until the job reaches a final state", async () => {
    let state = "running";
    serve({
      "agent.start": () => ({ id: "job2" }),
      "agent.cancel": () => {
        state = "cancelling";
        return { id: "job2", state };
      },
      "agent.status": () => ({ id: "job2", state, logs: [] }),
    });
    render(panel());
    fireEvent.change(screen.getByLabelText("편집 요청"), {
      target: { value: "도입부 줄여줘" },
    });
    fireEvent.click(screen.getByTitle("편집 요청 보내기 (⌘Enter)"));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("agent.start", {
        provider: "gemini",
        prompt: "도입부 줄여줘",
        projectId: "p1",
        clipId: undefined,
      }),
    );
    fireEvent.click(await screen.findByTitle("작업 중단"));
    expect(await screen.findByText("작업을 중단하는 중")).toBeInTheDocument();
    expect(screen.getByTitle("작업 중단")).toBeDisabled();
    const before = calls("agent.status").length;
    await waitFor(() => expect(calls("agent.status").length).toBeGreaterThan(before), {
      timeout: 3000,
    });
    state = "cancelled";
    expect(await screen.findByText("작업 중단", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 작업" })).toBeInTheDocument();
  });

  it("clears the job and unsaved input when the project changes", async () => {
    serve({
      "agent.list": () => [
        { id: "job1", provider: "gemini", state: "running", projectId: "p1", startedAt: 1 },
      ],
      "agent.status": ({ id }) => ({ id, state: "running", logs: [] }),
    });
    const { rerender } = render(panel());
    await screen.findByText("편집 작업 진행 중");
    fireEvent.change(screen.getByLabelText("편집 요청"), { target: { value: "초안" } });
    rerender(panel({ project: { ...project, id: "p2" } }));
    await waitFor(() => expect(screen.queryByText("편집 작업 진행 중")).toBeNull());
    expect(screen.getByLabelText("편집 요청")).toHaveValue("");
    expect(screen.queryByTitle("작업 중단")).toBeNull();
  });

  it("does not assume providers are usable when runtime status fails", async () => {
    serve({
      "runtime.status": () => {
        throw new Error("down");
      },
    });
    render(panel({ runtime: null }));
    expect(
      await screen.findByText("에이전트 상태를 확인하지 못했습니다."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("편집 요청"), { target: { value: "요청" } });
    expect(screen.getByTitle("편집 요청 보내기 (⌘Enter)")).toBeDisabled();
    expect(screen.getByLabelText("편집 에이전트")).toBeDisabled();
    serve({ "runtime.status": () => runtime });
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    await waitFor(() =>
      expect(screen.getByTitle("편집 요청 보내기 (⌘Enter)")).toBeEnabled(),
    );
    expect(calls("agent.start")).toHaveLength(0);
  });

  it("selects the first usable provider and shows sign-in requirements", async () => {
    serve({});
    render(panel());
    const select = screen.getByLabelText("편집 에이전트");
    expect(select).toHaveValue("gemini");
    expect(screen.getByRole("option", { name: "Claude Code · 미설치" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Codex · 로그인 필요" })).toBeEnabled();
    fireEvent.change(select, { target: { value: "codex" } });
    expect(screen.getByText(/Codex 로그인이 필요합니다/)).toBeInTheDocument();
  });

  it("backs off and stops polling after repeated failures until retried", async () => {
    vi.useFakeTimers();
    let fail = true;
    serve({
      "agent.start": () => ({ id: "job3" }),
      "agent.status": () => {
        if (fail) throw new Error("연결 끊김");
        return { id: "job3", state: "completed", logs: [], result: "끝" };
      },
    });
    render(panel());
    fireEvent.change(screen.getByLabelText("편집 요청"), { target: { value: "요청" } });
    fireEvent.click(screen.getByTitle("편집 요청 보내기 (⌘Enter)"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(calls("agent.status")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(calls("agent.status")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(calls("agent.status")).toHaveLength(5);
    expect(screen.getByText(/작업 상태를 확인하지 못했습니다/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(screen.getByText("작업 완료")).toBeInTheDocument();
    expect(screen.queryByText(/작업 상태를 확인하지 못했습니다/)).toBeNull();
  });

  it("keeps unsaved concept input when the project revision changes", async () => {
    serve({});
    const onCommand = vi.fn().mockResolvedValue(project);
    const { rerender } = render(panel({ onCommand }));
    fireEvent.click(screen.getByRole("button", { name: "컨셉" }));
    const audience = screen.getByLabelText("누구에게");
    const message = screen.getByLabelText("전달할 메시지");
    fireEvent.change(audience, { target: { value: "처음 온 여행자" } });
    const external = {
      ...project,
      revision: 4,
      concept: { ...project.concept, audience: "외부 변경", message: "바다" },
    };
    rerender(panel({ onCommand, project: external }));
    expect(audience).toHaveValue("처음 온 여행자");
    expect(message).toHaveValue("바다");
    fireEvent.blur(audience);
    expect(onCommand).toHaveBeenCalledWith("project.update", {
      patch: {
        concept: { ...external.concept, audience: "처음 온 여행자" },
      },
    });
    await act(async () => {});
    rerender(
      panel({
        onCommand,
        project: { ...external, concept: { ...external.concept, audience: "서버 값" } },
      }),
    );
    expect(audience).toHaveValue("서버 값");
  });
});
