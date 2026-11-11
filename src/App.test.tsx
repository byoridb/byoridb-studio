import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { connectStudio, pickFiles, rpc, uploadFile } from "./studio/api";
import * as mediaPlayback from "./studio/mediaPlayback";
import type { Project } from "./studio/types";

vi.mock("./studio/api", () => ({
  connectStudio: vi.fn(),
  rpc: vi.fn(),
  assetUrl: (id: string) => `http://studio/${id}`,
  pickFiles: vi.fn().mockResolvedValue(null),
  savePath: vi.fn().mockResolvedValue(null),
  uploadFile: vi.fn(),
}));
const initial: Project = {
  id: "test-project",
  name: "편집 테스트",
  revision: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  media: [
    {
      id: "image1",
      name: "풍경.jpg",
      path: "/tmp/image.jpg",
      kind: "image",
      duration: 5,
      width: 1920,
      height: 1080,
      hasAudio: false,
    },
  ],
  tracks: [
    {
      id: "video-1",
      name: "영상",
      kind: "video",
      muted: false,
      hidden: false,
      locked: false,
    },
  ],
  clips: [
    {
      id: "clip-1",
      mediaId: "image1",
      trackId: "video-1",
      name: "풍경.jpg",
      kind: "image",
      start: 0,
      duration: 5,
      sourceIn: 0,
      speed: 1,
      reverse: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
      keyframes: [],
    },
  ],
  markers: [],
  concept: { audience: "", message: "", appeal: "", direction: "" },
  notes: [],
  updatedAt: "2026-11-01",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.mocked(connectStudio).mockResolvedValue({
    url: "http://studio",
    token: "test",
  });
  vi.mocked(rpc).mockImplementation(async (method: string) => {
    if (method === "project.get") return structuredClone(initial);
    if (method === "history.status") return { canUndo: true, canRedo: false };
    if (method === "runtime.status")
      return {
        ffmpeg: { available: true },
        providers: [
          { id: "claude", name: "Claude Code", available: true },
          { id: "codex", name: "Codex", available: true },
          { id: "gemini", name: "Gemini CLI", available: true },
        ],
        byoridb: { installed: false, connected: false, running: false },
      };
    if (method === "project.save")
      return { path: "/tmp/test.json", project: initial };
    if (method === "agent.start") return { id: "agent1" };
    if (method === "agent.list") return [];
    if (method === "project.notice") return { notice: null };
    return initial;
  });
});
describe("Studio application", () => {
  it("holds the timeline while active media buffers and resumes without skipping the wait", async () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const waiting = vi.spyOn(mediaPlayback, "isPreviewPlaybackWaiting").mockReturnValue(true);
    const { container, unmount } = render(<App />);
    try {
      await screen.findByLabelText("프로젝트 이름");
      // Loading a project stops playback in an effect. Let it run before pressing
      // play: a click landing between that commit and its effects is undone by it
      // (the rare failure recorded below: playing=false, no frame requested).
      await act(async () => {});
      fireEvent.click(screen.getByTitle("재생 (Space)"));
      const start = performance.now();
      act(() => frame?.(start + 1000));
      expect(container.querySelector(".player-time")?.textContent).toBe("00:00:00:00 / 00:00:05:00");
      waiting.mockReturnValue(false);
      act(() => frame?.(start + 1100));
      // The message records the state should this fail again.
      expect(
        container.querySelector(".player-time")?.textContent,
        `playing=${!!screen.queryByTitle("일시정지 (Space)")} frames requested=${raf.mock.calls.length} waiting checks=${waiting.mock.calls.length} real ms since play=${Math.round(performance.now() - start)}`,
      ).toBe("00:00:00:03 / 00:00:05:00");
    } finally {
      unmount();
      raf.mockRestore(); cancel.mockRestore(); waiting.mockRestore();
    }
  });

  it("starts fast playback without waiting for a full-timeline render", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.click(screen.getByTitle("재생 (Space)"));
    expect(screen.getByTitle("일시정지 (Space)")).toBeInTheDocument();
    expect(
      vi.mocked(rpc).mock.calls.some(([method]) => method === "preview.start"),
    ).toBe(false);
    fireEvent.click(screen.getByTitle("일시정지 (Space)"));
    expect(screen.getByTitle("재생 (Space)")).toBeInTheDocument();
  });

  it("seeks the existing precise preview back to zero when replaying from the end", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method === "preview.start") return { id: "preview-job", assetId: "preview-video" };
      if (method === "export.status") return { id: "preview-job", state: "completed" };
      return fallback(method, params, projectId);
    });
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const ready = vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    const duration = vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(5);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { container, unmount } = render(<App />);
    try {
      await screen.findByLabelText("프로젝트 이름");
      fireEvent.click(screen.getByRole("button", { name: "정밀 재생" }));
      fireEvent.click(screen.getByTitle("재생 (Space)"));
      await screen.findByTitle("일시정지 (Space)");
      const proxy = container.querySelector<HTMLVideoElement>("video.rendered-preview")!;
      expect(proxy).not.toBeNull();

      fireEvent.click(screen.getByTitle("일시정지 (Space)"));
      fireEvent.keyDown(document.body, { key: "End" });
      expect(proxy.currentTime).toBeCloseTo(4.999);
      fireEvent.click(screen.getByTitle("재생 (Space)"));
      await waitFor(() => {
        expect(container.querySelector(".player-time")?.textContent).toBe("00:00:00:00 / 00:00:05:00");
        expect(proxy.currentTime).toBe(0);
      });
      expect(container.querySelector("video.rendered-preview")).toBe(proxy);
      expect(vi.mocked(rpc).mock.calls.filter(([method]) => method === "preview.start")).toHaveLength(1);
    } finally {
      unmount();
      raf.mockRestore(); cancel.mockRestore(); ready.mockRestore(); duration.mockRestore();
      play.mockRestore(); pause.mockRestore();
    }
  });

  it("opens the editing workspace even when ByoriDB is not connected", async () => {
    render(<App />);
    expect(await screen.findByLabelText("프로젝트 이름")).toHaveValue(
      "편집 테스트",
    );
    expect(
      screen.getByRole("region", { name: "타임라인" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "내보내기" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("saves the active project through the common command interface", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("project.save", {}, "test-project"),
    );
    // Saving is automatic, so ⌘S stays quiet and the menu has no save entry.
    await act(async () => {});
    expect(screen.queryByText(/저장됨 ·/)).toBeNull();
    expect(screen.getByTitle("자동 저장")).toHaveTextContent("저장됨");
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    expect(screen.queryByRole("button", { name: /^저장/ })).toBeNull();
  });
  it("routes a natural language request to the selected CLI provider", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    await user.click(screen.getByRole("button", { name: "어시스턴트" }));
    await user.type(
      screen.getByRole("textbox", { name: "편집 요청" }),
      "도입부를 2초로 줄여줘",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "편집 에이전트" }),
      "codex",
    );
    await user.click(screen.getByTitle("편집 요청 보내기 (⌘Enter)"));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("agent.start", {
        provider: "codex",
        prompt: "도입부를 2초로 줄여줘",
        projectId: "test-project",
        clipId: undefined,
      }),
    );
  });
  it("keeps failed connections explicit and offers retry", async () => {
    vi.mocked(connectStudio).mockRejectedValueOnce(
      new Error("서버를 시작해 주세요"),
    );
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("서버를 시작해 주세요")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다시 연결" }));
    expect(await screen.findByLabelText("프로젝트 이름")).toHaveValue(
      "편집 테스트",
    );
  });
  it("does not intercept typing shortcuts inside the project name input", async () => {
    render(<App />);
    const name = await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(name, { key: "s", metaKey: true });
    expect(rpc).not.toHaveBeenCalledWith("project.save", {}, "test-project");
  });
  it.each([
    { key: "b", metaKey: true, method: "edit.split", bounds: { time: 1 } },
    { key: "q", metaKey: false, method: "edit.trim", bounds: { start: 1 } },
    { key: "w", metaKey: false, method: "edit.trim", bounds: { end: 1 } },
  ])("edits selected clips at the playhead with $key", async ({ key, metaKey, method, bounds }) => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key, metaKey });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      method, { id: "clip-1", ...bounds, expectedRevision: 1 }, "test-project",
    ));
  });
  it("ignores trim shortcuts while typing, composing, repeating, or at a clip boundary", async () => {
    render(<App />);
    const name = await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, { key: "q" });
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(name, { key: "q" });
    fireEvent.keyDown(name, { key: "w" });
    fireEvent.keyDown(document.body, { key: "q", repeat: true });
    fireEvent.keyDown(document.body, { key: "w", isComposing: true });
    fireEvent.keyDown(document.body, { key: "q", altKey: true });
    fireEvent.keyDown(document.body, { key: "w", metaKey: true });
    expect(vi.mocked(rpc).mock.calls.some(([method]) => method.startsWith("edit."))).toBe(false);
  });
  it("splits selected clips on multiple layers as one revision-guarded batch", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    const layered = structuredClone(initial);
    layered.tracks.push({ ...layered.tracks[0], id: "video-2", name: "영상 2" });
    layered.clips.push({ ...layered.clips[0], id: "clip-2", trackId: "video-2", duration: 3 });
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "project.get" ? layered : fallback(method, params, projectId),
    );
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "b", metaKey: true });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("edit.batch", {
      expectedRevision: 1,
      commands: [
        { method: "edit.split", params: { id: "clip-1", time: 1 } },
        { method: "edit.split", params: { id: "clip-2", time: 1 } },
      ],
    }, "test-project"));
  });
  it("selects all clips and ripple deletes with one revision-guarded command", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    expect(
      screen.getByRole("button", { name: "풍경.jpg, 0.0초, 5.0초" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(document.body, { key: "Delete", shiftKey: true });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "edit.delete",
        {
          ids: ["clip-1"],
          ripple: true,
          expectedRevision: 1,
        },
        "test-project",
      ),
    );
  });
  it("nudges selected clips in a batch and leaves text editing shortcuts alone", async () => {
    render(<App />);
    const name = await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(name, { key: "a", metaKey: true });
    expect(
      screen.getByRole("button", { name: "풍경.jpg, 0.0초, 5.0초" }),
    ).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "edit.batch",
        {
          expectedRevision: 1,
          commands: [
            {
              method: "edit.update",
              params: { id: "clip-1", patch: { start: 10 / 30 } },
            },
          ],
        },
        "test-project",
      ),
    );
    fireEvent.keyDown(name, { key: "Delete" });
    expect(
      vi.mocked(rpc).mock.calls.some(([method]) => method === "edit.delete"),
    ).toBe(false);
  });
  it("refreshes history after a browser upload and enables Undo", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    let historyReads = 0;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method === "history.status") {
        historyReads++;
        return { canUndo: historyReads > 1, canRedo: false };
      }
      return fallback(method, params, projectId);
    });
    const uploaded = {
      ...initial,
      revision: 2,
      media: [
        ...initial.media,
        { ...initial.media[0], id: "uploaded-image", name: "업로드.jpg" },
      ],
    };
    vi.mocked(uploadFile).mockResolvedValueOnce(uploaded);
    const { container } = render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    await waitFor(() => expect(historyReads).toBe(1));
    expect(screen.getByTitle("실행 취소 (⌘Z)")).toBeDisabled();

    const file = new File(["image bytes"], "업로드.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(uploadFile).toHaveBeenCalledWith(file, "test-project");
      expect(rpc).toHaveBeenCalledWith("history.status", {}, "test-project");
      expect(historyReads).toBe(2);
      expect(screen.getByTitle("실행 취소 (⌘Z)")).toBeEnabled();
    });
    expect(screen.getByText("업로드.jpg")).toBeInTheDocument();
  });

  it("ignores old-project polls started before and during a project switch", async () => {
    vi.useFakeTimers();
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    const pendingPolls: ((project: Project) => void)[] = [];
    let initialized = false;
    let finishSwitch!: (project: Project) => void;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method === "project.get") {
        if (!initialized) {
          initialized = true;
          return structuredClone(initial);
        }
        return new Promise<Project>((resolve) => pendingPolls.push(resolve));
      }
      if (method === "project.new") {
        return new Promise<Project>((resolve) => {
          finishSwitch = resolve;
        });
      }
      return fallback(method, params, projectId);
    });
    const nextProject = {
      ...initial,
      id: "project-b",
      name: "새 프로젝트 B",
      revision: 0,
    };
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => {
        view = render(<App />);
      });
      expect(screen.getByLabelText("프로젝트 이름")).toHaveValue(initial.name);

      await act(async () => {
        vi.advanceTimersByTime(1200);
      });
      expect(pendingPolls).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
      fireEvent.click(screen.getByRole("button", { name: "새 프로젝트" }));
      expect(finishSwitch).toBeTypeOf("function");

      // This poll captures the generation after the switch request has started.
      await act(async () => {
        vi.advanceTimersByTime(1200);
      });
      expect(pendingPolls).toHaveLength(2);
      await act(async () => {
        finishSwitch(nextProject);
      });
      expect(screen.getByLabelText("프로젝트 이름")).toHaveValue(
        nextProject.name,
      );

      await act(async () => {
        pendingPolls[0]({ ...initial, revision: 20 });
      });
      expect(screen.getByLabelText("프로젝트 이름")).toHaveValue(
        nextProject.name,
      );
      await act(async () => {
        pendingPolls[1]({ ...initial, revision: 21 });
      });
      expect(screen.getByLabelText("프로젝트 이름")).toHaveValue(
        nextProject.name,
      );
      expect(rpc).toHaveBeenCalledWith("history.status", {}, "project-b");
      expect(rpc).not.toHaveBeenCalledWith(
        "history.status",
        {},
        "test-project",
      );
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });
  it("uses the physical key for letter shortcuts while a Hangul IME is active", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "ㅁ", code: "KeyA", metaKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "ㅂ", code: "KeyQ" });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "edit.trim", { id: "clip-1", start: 1, expectedRevision: 1 }, "test-project",
    ));
    fireEvent.keyDown(document.body, { key: "ㅡ", code: "KeyM" });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "edit.marker", { time: 1, label: "마커", expectedRevision: 1 }, "test-project",
    ));
  });
  it("plays with Space right after a clip is clicked", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const clip = screen.getByRole("button", { name: "풍경.jpg, 0.0초, 5.0초" });
    fireEvent.pointerDown(clip, { clientX: 10 });
    fireEvent.pointerUp(clip);
    expect(clip).toHaveFocus();
    fireEvent.keyDown(clip, { key: " ", code: "Space" });
    expect(screen.getByTitle("일시정지 (Space)")).toBeInTheDocument();
  });
  it("keeps the selection across a newer revision and drops clips that no longer exist", async () => {
    vi.useFakeTimers();
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    let served: Project = structuredClone(initial);
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "project.get" ? structuredClone(served) : fallback(method, params, projectId),
    );
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => { view = render(<App />); });
      // Selecting in the same tick as the first project render must stick.
      fireEvent.keyDown(document.body, { key: "a", metaKey: true });
      const clip = () => screen.queryByRole("button", { name: "풍경.jpg, 0.0초, 5.0초" });
      expect(clip()).toHaveAttribute("aria-pressed", "true");
      served = { ...structuredClone(initial), revision: 2, name: "바뀐 이름" };
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
      expect(clip()).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("1개 선택")).toBeInTheDocument();
      served = { ...structuredClone(initial), revision: 3, clips: [] };
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
      expect(clip()).toBeNull();
      expect(screen.queryByText("1개 선택")).not.toBeInTheDocument();
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });
  it("polls conditionally, one request at a time, and ignores an unchanged reply", async () => {
    vi.useFakeTimers();
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    const polls: { params: unknown; resolve: (value: unknown) => void }[] = [];
    let initialized = false;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method !== "project.get") return fallback(method, params, projectId);
      if (!initialized) { initialized = true; return structuredClone(initial); }
      return new Promise((resolve) => polls.push({ params, resolve }));
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => { view = render(<App />); });
      await act(async () => { vi.advanceTimersByTime(1200); });
      expect(polls.map((poll) => poll.params)).toEqual([{ ifProjectId: "test-project", ifRevision: 1 }]);
      await act(async () => { vi.advanceTimersByTime(2400); });
      expect(polls).toHaveLength(1);
      const historyReads = () => vi.mocked(rpc).mock.calls.filter(([method]) => method === "history.status").length;
      const before = historyReads();
      await act(async () => { polls[0].resolve({ unchanged: true, id: "test-project", revision: 1 }); });
      expect(screen.getByLabelText("프로젝트 이름")).toHaveValue(initial.name);
      expect(historyReads()).toBe(before);
      await act(async () => { vi.advanceTimersByTime(1200); });
      expect(polls).toHaveLength(2);
      await act(async () => { polls[1].resolve({ ...structuredClone(initial), revision: 2, name: "에이전트 편집" }); });
      expect(screen.getByLabelText("프로젝트 이름")).toHaveValue("에이전트 편집");
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });
  it("re-reads the project when an unchanged reply reports a different missing set, or periodically without one", async () => {
    vi.useFakeTimers();
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    const polls: unknown[] = [];
    let reply: (() => unknown) | undefined;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method !== "project.get") return fallback(method, params, projectId);
      if (!reply) { reply = () => ({ unchanged: true, id: "test-project", revision: 1, missing: [] }); return structuredClone(initial); }
      polls.push(params);
      return reply();
    });
    const conditional = { ifProjectId: "test-project", ifRevision: 1 };
    const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => { view = render(<App />); });
      await tick();
      await tick();
      expect(polls).toEqual([conditional, conditional]);
      // Another caller already consumed the change: same revision, new missing set.
      const gone = structuredClone(initial);
      gone.media[0].missing = true;
      reply = () => ({ unchanged: true, id: "test-project", revision: 1, missing: [gone.media[0].id] });
      await tick();
      expect(screen.queryByText(/원본 파일을 찾을 수 없습니다/)).not.toBeInTheDocument();
      reply = () => structuredClone(gone);
      await tick();
      expect(polls.slice(2)).toEqual([conditional, {}]);
      expect(screen.getByText(/원본 파일을 찾을 수 없습니다/)).toBeInTheDocument();
      // A core that reports no missing set is re-read in full every few polls.
      polls.length = 0;
      reply = () => ({ unchanged: true, id: "test-project", revision: 1 });
      for (let i = 0; i < 6; i++) await tick();
      expect(polls).toEqual([conditional, conditional, conditional, conditional, conditional, {}]);
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });
  it("reports the real save state: saving, saved, and a lost service connection", async () => {
    vi.useFakeTimers();
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    let offline = false;
    let finishEdit!: (value: unknown) => void;
    let initialized = false;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method === "project.get" && initialized && offline) throw new TypeError("Failed to fetch");
      if (method === "project.get") initialized = true;
      if (method === "edit.marker") return new Promise((resolve) => { finishEdit = resolve; });
      return fallback(method, params, projectId);
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => { view = render(<App />); });
      const state = () => screen.getByLabelText("프로젝트 이름").nextElementSibling;
      expect(state()).toHaveTextContent("저장됨");
      await act(async () => { fireEvent.keyDown(document.body, { key: "m" }); });
      expect(state()).toHaveTextContent("저장 중");
      await act(async () => { finishEdit({ ...structuredClone(initial), revision: 2 }); });
      expect(state()).toHaveTextContent("저장됨");
      offline = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
      expect(state()).toHaveTextContent("저장됨");
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
      expect(state()).toHaveTextContent("연결 끊김");
      offline = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
      expect(state()).toHaveTextContent("저장됨");
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });
  it("shows a startup notice from the service until it is dismissed", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "project.notice"
        ? { notice: "손상된 프로젝트를 백업에서 복구했습니다." }
        : method === "project.noticeDismiss" ? { notice: null } : fallback(method, params, projectId),
    );
    render(<App />);
    expect(await screen.findByText("손상된 프로젝트를 백업에서 복구했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    expect(screen.queryByText("손상된 프로젝트를 백업에서 복구했습니다.")).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("project.noticeDismiss");
  });
  it("flags missing source media and relinks it through the native file picker", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    const broken = structuredClone(initial);
    broken.media[0].missing = true;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "project.get" ? broken : fallback(method, params, projectId),
    );
    render(<App />);
    expect(await screen.findByText("원본 파일을 찾을 수 없습니다 · 풍경.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 연결" }));
    expect(await screen.findByText("원본 다시 연결은 데스크톱 앱에서 할 수 있습니다.")).toBeInTheDocument();
    expect(vi.mocked(rpc).mock.calls.some(([method]) => method === "media.relink")).toBe(false);
    vi.mocked(pickFiles).mockResolvedValueOnce(["/Volumes/new/풍경.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "다시 연결" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "media.relink", { id: "image1", path: "/Volumes/new/풍경.jpg", expectedRevision: 1 }, "test-project",
    ));
  });
  it("copies, cuts and pastes the selection at the playhead", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    const pasted = structuredClone(initial);
    pasted.revision = 2;
    pasted.clips.push({ ...pasted.clips[0], id: "clip-2", start: 1 });
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "edit.paste" ? pasted : fallback(method, params, projectId),
    );
    render(<App />);
    const name = await screen.findByLabelText("프로젝트 이름");
    fireEvent.keyDown(document.body, { key: "v", metaKey: true });
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(name, { key: "c", metaKey: true });
    fireEvent.keyDown(name, { key: "v", metaKey: true });
    expect(vi.mocked(rpc).mock.calls.some(([method]) => method === "edit.paste")).toBe(false);
    fireEvent.keyDown(document.body, { key: "c", metaKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "v", metaKey: true });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "edit.paste", { clips: [initial.clips[0]], at: 1, expectedRevision: 1 }, "test-project",
    ));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "풍경.jpg, 1.0초, 5.0초" }),
    ).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(document.body, { key: "x", metaKey: true });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "edit.delete", { ids: ["clip-2"], expectedRevision: 2 }, "test-project",
    ));
  });
  it("closes the open-project dialog with Escape", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "project.list" ? [] : fallback(method, params, projectId),
    );
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 열기" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
