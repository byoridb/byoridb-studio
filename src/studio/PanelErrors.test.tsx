import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { connectStudio, rpc } from "./api";
import type { Project } from "./types";

// The whole app in jsdom, as in App.test.tsx: the same headroom for a busy machine.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

vi.mock("./api", () => ({
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
    { id: "video-1", name: "영상", kind: "video", muted: false, hidden: false, locked: false },
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

const conflict = "프로젝트가 다른 작업에 의해 변경되었습니다. (REVISION_CONFLICT)";
const sentence = "프로젝트가 다른 작업에 의해 변경되었습니다.";
/** The methods that fail in a test; every other request answers as a healthy service. */
let failing: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  failing = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.mocked(connectStudio).mockResolvedValue({ url: "http://studio", token: "test" });
  vi.mocked(rpc).mockImplementation(async (method: string) => {
    if (failing.includes(method)) throw new Error(conflict);
    if (method === "project.get") return structuredClone(initial);
    if (method === "history.status") return { canUndo: true, canRedo: false };
    if (method === "runtime.status")
      return {
        ffmpeg: { available: true },
        providers: [{ id: "claude", name: "Claude Code", available: true }],
        byoridb: { installed: false, connected: false, running: false },
      };
    if (method === "agent.list") return [];
    if (method === "project.notice") return { notice: null };
    return initial;
  });
});

const toast = () => document.querySelector(".studio-notification.error");
const sent = (method: string) => vi.mocked(rpc).mock.calls.filter(([name]) => name === method);
const open = async () => {
  const view = render(<App />);
  await screen.findByLabelText("프로젝트 이름");
  return view;
};

describe("panel failures", () => {
  it("shows a failed library command in the library only, without a toast", async () => {
    failing = ["edit.add"];
    await open();
    fireEvent.click(screen.getByRole("button", { name: "풍경.jpg 타임라인에 추가" }));
    const alert = await screen.findByRole("alert");
    expect(sent("edit.add")).toHaveLength(1);
    expect(alert).toHaveTextContent(sentence);
    // The service code is for the tooltip, not for reading.
    expect(alert).not.toHaveTextContent("REVISION_CONFLICT");
    expect(alert).toHaveAttribute("title", conflict);
    // Pinned below the list, so it shows at any scroll position.
    expect(alert.closest(".studio-library")).not.toBeNull();
    expect(alert.closest(".library-content")).toBeNull();
    expect(toast()).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByText(sentence)).toHaveLength(1);
  });

  it("shows a failed inspector edit in the inspector only, without a toast", async () => {
    failing = ["edit.update"];
    await open();
    const clip = screen.getByRole("button", { name: "풍경.jpg, 0.0초, 5.0초" });
    fireEvent.pointerDown(clip, { clientX: 10 });
    fireEvent.pointerUp(clip);
    const scale = await screen.findByRole("spinbutton", { name: "크기" });
    fireEvent.change(scale, { target: { value: "125" } });
    fireEvent.blur(scale);
    const alert = await screen.findByRole("alert");
    expect(sent("edit.update")).toHaveLength(1);
    expect(alert).toHaveTextContent(sentence);
    expect(alert).toHaveAttribute("title", conflict);
    expect(alert.closest(".studio-inspector")).not.toBeNull();
    expect(alert.closest(".inspector-scroll")).toBeNull();
    expect(toast()).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByText(sentence)).toHaveLength(1);
  });

  it("clears the panel's message with the next edit that succeeds", async () => {
    failing = ["edit.update"];
    await open();
    const clip = screen.getByRole("button", { name: "풍경.jpg, 0.0초, 5.0초" });
    fireEvent.pointerDown(clip, { clientX: 10 });
    fireEvent.pointerUp(clip);
    const scale = await screen.findByRole("spinbutton", { name: "크기" });
    fireEvent.change(scale, { target: { value: "125" } });
    fireEvent.blur(scale);
    await screen.findByRole("alert");
    failing = [];
    fireEvent.change(scale, { target: { value: "150" } });
    fireEvent.blur(scale);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(sent("edit.update")).toHaveLength(2);
    expect(toast()).toBeNull();
  });

  it("raises the same sentence as a toast when the failure comes from outside the panels", async () => {
    failing = ["edit.marker"];
    await open();
    fireEvent.keyDown(document.body, { key: "m", code: "KeyM" });
    await waitFor(() => expect(toast()).not.toBeNull());
    expect(toast()).toHaveTextContent(sentence);
    expect(toast()).not.toHaveTextContent("REVISION_CONFLICT");
    expect(document.querySelector(".panel-inline-error")).toBeNull();
  });
});
