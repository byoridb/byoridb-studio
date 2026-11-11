import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { connectStudio, rpc } from "./studio/api";
import * as mediaPlayback from "./studio/mediaPlayback";
import { playbackClock } from "./studio/playbackClock";
import type { Clip, Project } from "./studio/types";

vi.mock("./studio/api", () => ({
  connectStudio: vi.fn(),
  rpc: vi.fn(),
  assetUrl: (id: string) => `http://studio/${id}`,
  pickFiles: vi.fn().mockResolvedValue(null),
  savePath: vi.fn().mockResolvedValue(null),
  uploadFile: vi.fn(),
}));
// The side panels belong to another area; here they only count their renders.
const renders = vi.hoisted(() => ({ library: 0, inspector: 0, playheads: [] as number[] }));
vi.mock("./studio/Library", () => ({
  default: ({ playhead }: { playhead: number }) => { renders.library++; renders.playheads.push(playhead); return <section aria-label="라이브러리" />; },
}));
vi.mock("./studio/Inspector", () => ({
  default: () => { renders.inspector++; return <section aria-label="속성" />; },
}));

const clip = (id: string, start: number, trackId: string): Clip => ({
  id, mediaId: "image1", trackId, name: id, kind: "image", start, duration: 2, sourceIn: 0, speed: 1, reverse: false,
  volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [],
});
const base: Project = {
  id: "test-project", name: "편집 테스트", revision: 1, width: 1920, height: 1080, fps: 30, background: "#000000",
  media: [{ id: "image1", name: "풍경.jpg", path: "/tmp/image.jpg", kind: "image", duration: 5, width: 1920, height: 1080, hasAudio: false }],
  tracks: Array.from({ length: 5 }, (_, index) => ({ id: `t${index}`, name: `영상 ${index + 1}`, kind: "video" as const, muted: false, hidden: false, locked: false })),
  clips: Array.from({ length: 500 }, (_, index) => clip(`c${index}`, Math.floor(index / 5) * 2, `t${index % 5}`)),
  markers: [], concept: { audience: "", message: "", appeal: "", direction: "" }, notes: [], updatedAt: "2026-11-01",
};
const blank: Project = { ...base, id: "blank", name: "이름 없는 프로젝트", clips: [], media: [] };
let served: Project;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  renders.library = renders.inspector = 0;
  renders.playheads = [];
  served = structuredClone(base);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.mocked(connectStudio).mockResolvedValue({ url: "http://studio", token: "test" });
  vi.mocked(rpc).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === "project.get") return structuredClone(served);
    if (method === "history.status") return { canUndo: false, canRedo: false };
    if (method === "runtime.status") return { ffmpeg: { available: true }, providers: [], byoridb: { installed: false, connected: false, running: false } };
    if (method === "project.notice") return { notice: null };
    if (method === "project.list") return [{ id: served.id, name: served.name, updatedAt: 2 }, { id: "other", name: "다른 편집", updatedAt: 1 }];
    if (method === "project.new") return (served = { ...structuredClone(blank), id: "created", width: Number(params?.width), height: Number(params?.height) });
    if (method === "project.open") return (served = { ...structuredClone(base), id: String(params?.id), name: "다른 편집" });
    if (method === "preview.frame") throw new Error("no renderer");
    return structuredClone(served);
  });
});

describe("playback clock", () => {
  it("plays a 500-clip project without re-rendering the app, library or inspector", async () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(mediaPlayback, "isPreviewPlaybackWaiting").mockReturnValue(false);
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { container } = render(<App />);
      await screen.findByLabelText("프로젝트 이름");
      await act(async () => {});
      fireEvent.keyDown(document.body, { code: "Space", key: " " });
      await act(async () => {});
      const before = { ...renders, clips: container.querySelectorAll(".timeline-clip").length, nodes: container.querySelectorAll("*").length };
      for (let step = 1; step <= 120; step++) {
        now.mockReturnValue((step * 1000) / 60);
        act(() => frame?.((step * 1000) / 60));
      }
      expect(playbackClock.get()).toBeCloseTo(2);
      expect(container.querySelector(".player-time")).toHaveTextContent("00:00:02:00");
      expect(parseFloat(container.querySelector<HTMLElement>(".playhead")!.style.left)).toBeCloseTo(2 * 68);
      const during = { library: renders.library - before.library, inspector: renders.inspector - before.inspector };
      expect(during).toEqual({ library: 0, inspector: 0 });
      expect(before.clips).toBeLessThanOrEqual(65);
      // Pausing hands the panels the playhead they did not follow during playback.
      fireEvent.keyDown(document.body, { code: "Space", key: " " });
      await act(async () => {});
      expect(renders.playheads[renders.playheads.length - 1]).toBeCloseTo(2);
      console.info(`[perf] app 500 clips: ${during.library} library / ${during.inspector} inspector renders over 120 playback frames; ${before.clips} timeline clip elements, ${before.nodes} DOM nodes in the editor`);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
      now.mockRestore();
    }
  });
  it("repeats the range marked with I and O", async () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(mediaPlayback, "isPreviewPlaybackWaiting").mockReturnValue(false);
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { container } = render(<App />);
      await screen.findByLabelText("프로젝트 이름");
      await act(async () => {});
      fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
      fireEvent.keyDown(document.body, { key: "i", code: "KeyI" });
      fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
      // The Hangul layout reports the jamo; the physical key still marks the end.
      fireEvent.keyDown(document.body, { key: "ㅐ", code: "KeyO" });
      const band = container.querySelector<HTMLElement>(".timeline-loop")!;
      expect(band.style.left).toBe("68px");
      expect(band.style.width).toBe("68px");
      expect(screen.getByRole("button", { name: "구간 반복" })).toHaveAttribute("aria-pressed", "true");
      // Starting at the end of the range begins again from its start.
      const epoch = playbackClock.epoch();
      fireEvent.keyDown(document.body, { code: "Space", key: " " });
      await act(async () => {});
      expect(playbackClock.get()).toBe(1);
      now.mockReturnValue(600);
      act(() => frame?.(600));
      expect(playbackClock.get()).toBeCloseTo(1.6);
      now.mockReturnValue(1100);
      act(() => frame?.(1100));
      expect(playbackClock.get()).toBe(1);
      expect(playbackClock.epoch()).toBe(epoch + 2);
      expect(screen.getByTitle("일시정지 (Space)")).toBeInTheDocument();
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
      now.mockRestore();
    }
  });
  it("rests on a whole frame after pausing mid-frame, so the precise frame and new clips agree", async () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(mediaPlayback, "isPreviewPlaybackWaiting").mockReturnValue(false);
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      render(<App />);
      await screen.findByLabelText("프로젝트 이름");
      await act(async () => {});
      act(() => playbackClock.seek(0));
      fireEvent.keyDown(document.body, { code: "Space", key: " " });
      await act(async () => {});
      act(() => frame?.(1247));
      expect(playbackClock.get()).toBeCloseTo(1.247);
      fireEvent.keyDown(document.body, { code: "Space", key: " " });
      await act(async () => {});
      // 1.247 s is between frames 37 and 38 of a 30 fps project.
      expect(playbackClock.get()).toBe(37 / 30);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
      now.mockRestore();
    }
  });
});

describe("home screen", () => {
  it("opens on home for an untouched project and enters the editor with the chosen frame", async () => {
    served = structuredClone(blank);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "최근 프로젝트" })).toBeInTheDocument();
    expect(screen.queryByLabelText("타임라인")).toBeNull();
    // Editing shortcuts do nothing here.
    fireEvent.keyDown(document.body, { key: "m" });
    expect(rpc).not.toHaveBeenCalledWith("edit.marker", expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트 9:16 세로" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("project.new", { name: "이름 없는 프로젝트", width: 1080, height: 1920, fps: 30 }, undefined));
    expect(await screen.findByLabelText("타임라인")).toBeInTheDocument();
    expect(screen.getByText("9:16")).toBeInTheDocument();
  });
  it("goes home from the menu, returns to the open project without reloading it, and opens another", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    fireEvent.click(await screen.findByRole("button", { name: "편집 테스트 열기" }));
    expect(await screen.findByLabelText("타임라인")).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalledWith("project.open", expect.anything(), undefined);
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    act(() => playbackClock.seek(3));
    fireEvent.click(await screen.findByRole("button", { name: "다른 편집 열기" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("project.open", { id: "other" }, undefined));
    expect(await screen.findByLabelText("프로젝트 이름")).toHaveValue("다른 편집");
    expect(playbackClock.get()).toBe(0);
  });
});

describe("workspace layout", () => {
  it("resizes the side panels and the timeline and restores them on the next start", async () => {
    const first = render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const workspace = () => document.querySelector<HTMLElement>(".upper-workspace")!;
    const widths = () => [workspace().style.getPropertyValue("--library-width"), workspace().style.getPropertyValue("--inspector-width")];
    // Untouched panels leave the columns to the stylesheet and its media queries.
    expect(workspace().style.gridTemplateColumns).toBe("");
    expect(widths()).toEqual(["", ""]);
    const library = screen.getByRole("separator", { name: "라이브러리 폭 조절" });
    const panel = library.previousElementSibling as HTMLElement;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ left: 6, right: 326, top: 0, bottom: 400, width: 320, height: 400, x: 6, y: 0, toJSON: () => ({}) });
    fireEvent.keyDown(library, { key: "ArrowRight" });
    expect(widths()[0]).toBe("336px");
    library.setPointerCapture = vi.fn();
    library.hasPointerCapture = () => true;
    library.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(library, { clientX: 340 });
    fireEvent.pointerMove(library, { clientX: 406 });
    fireEvent.pointerUp(library);
    expect(widths()[0]).toBe("400px");
    fireEvent.pointerMove(library, { clientX: 5000 });
    expect(widths()[0]).toBe("560px");
    const inspector = screen.getByRole("separator", { name: "속성 패널 폭 조절" });
    fireEvent.keyDown(inspector, { key: "ArrowLeft" });
    expect(widths()[1]).toBe("294px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "타임라인 높이 조절" }), { key: "ArrowUp" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("byori.layout")!)).toEqual({ library: 560, inspector: 294, timeline: 320 }));
    first.unmount();
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    expect(widths()).toEqual(["560px", "294px"]);
    expect(document.querySelector<HTMLElement>(".editing-surface")!.style.gridTemplateRows).toContain("320px");
    fireEvent.doubleClick(screen.getByRole("separator", { name: "라이브러리 폭 조절" }));
    expect(widths()[0]).toBe("");
  });
  it("narrows stored panel widths to the window without forgetting them", async () => {
    const { fitPanelWidths } = await import("./App");
    // Unmeasured, or wide enough: exactly what was chosen.
    expect(fitPanelWidths({ library: 560, inspector: 520 }, 0)).toEqual({ library: 560, inspector: 520 });
    expect(fitPanelWidths({ library: 560, inspector: 520 }, 1600)).toEqual({ library: 560, inspector: 520 });
    expect(fitPanelWidths({ library: null, inspector: 278 }, 900)).toEqual({ library: null, inspector: null });
    // 560 + 520 + separators + the 250px player do not fit 1280px.
    const fitted = fitPanelWidths({ library: 560, inspector: 520 }, 1280);
    expect(fitted.library! + fitted.inspector! + 262).toBeLessThanOrEqual(1280);
    expect(fitted.library!).toBeGreaterThanOrEqual(220);
    expect(fitted.inspector!).toBeGreaterThanOrEqual(240);
    const wide = fitPanelWidths({ library: null, inspector: 520 }, 1000);
    expect(wide.library).toBeNull();
    expect(wide.inspector! + 290 + 262).toBeLessThanOrEqual(1000);

    localStorage.setItem("byori.layout", JSON.stringify({ library: 560, inspector: 520, timeline: 300 }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const size = this.classList.contains("editing-surface") ? { width: 1280, height: 800 } : { width: 0, height: 0 };
      return { left: 0, top: 0, right: size.width, bottom: size.height, x: 0, y: 0, ...size, toJSON: () => ({}) };
    });
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const style = document.querySelector<HTMLElement>(".upper-workspace")!.style;
    await waitFor(() => expect(style.getPropertyValue("--library-width")).toBe(`${fitted.library}px`));
    expect(style.getPropertyValue("--inspector-width")).toBe(`${fitted.inspector}px`);
    expect(JSON.parse(localStorage.getItem("byori.layout")!)).toMatchObject({ library: 560, inspector: 520 });
  });
  it("cancels a project rename with Escape", async () => {
    render(<App />);
    const name = await screen.findByLabelText("프로젝트 이름");
    fireEvent.change(name, { target: { value: "버릴 이름" } });
    fireEvent.keyDown(name, { key: "Escape" });
    fireEvent.blur(name);
    expect(name).toHaveValue("편집 테스트");
    expect(rpc).not.toHaveBeenCalledWith("project.update", expect.anything(), expect.anything());
  });
});
