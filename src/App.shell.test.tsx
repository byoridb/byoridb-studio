import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { connectStudio, rpc } from "./studio/api";
import * as mediaPlayback from "./studio/mediaPlayback";
import { playbackClock } from "./studio/playbackClock";
import type { Clip, Project } from "./studio/types";

// Whole-app renders in jsdom: a saturated CPU stretches them past the default limits
// (see App.test.tsx), so those are raised for this file.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

vi.mock("./studio/api", () => ({
  connectStudio: vi.fn(),
  rpc: vi.fn(),
  assetUrl: (id: string) => `http://studio/${id}`,
  pickFiles: vi.fn().mockResolvedValue(null),
  savePath: vi.fn().mockResolvedValue(null),
  uploadFile: vi.fn(),
}));
// The side panels belong to another area; here they only count their renders.
const renders = vi.hoisted(() => ({
  library: 0, inspector: 0, playheads: [] as number[],
  /** The command the library is given, for adding text and stickers. */
  libraryCommand: null as null | ((method: string, params?: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock("./studio/Library", () => ({
  default: ({ playhead, onCommand }: { playhead: number; onCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown> }) => {
    renders.library++;
    renders.playheads.push(playhead);
    renders.libraryCommand = onCommand;
    return <section aria-label="라이브러리" />;
  },
}));
vi.mock("./studio/Inspector", () => ({
  default: ({ covered }: { covered?: boolean }) => {
    renders.inspector++;
    return <section className="studio-inspector" aria-label="속성" tabIndex={-1} inert={covered} />;
  },
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

describe("playback and project state", () => {
  it("keeps fast playback running through an edit and stops it for another project", async () => {
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      render(<App />);
      await screen.findByLabelText("프로젝트 이름");
      fireEvent.click(screen.getByTitle("재생 (Space)"));
      expect(screen.getByTitle("일시정지 (Space)")).toBeInTheDocument();
      // A newer revision of the same project (here: a marker) arrives while playing.
      served = { ...served, revision: 2, markers: [{ id: "m", time: 1, label: "마커" }] };
      fireEvent.keyDown(document.body, { key: "m", code: "KeyM" });
      await screen.findByRole("button", { name: "마커 마커" });
      expect(screen.getByTitle("일시정지 (Space)")).toBeInTheDocument();
      // Another project is never playing, and coming back does not resume.
      fireEvent.click(screen.getByRole("button", { name: "홈" }));
      fireEvent.click(await screen.findByRole("button", { name: "다른 편집 열기" }));
      expect(await screen.findByLabelText("프로젝트 이름")).toHaveValue("다른 편집");
      expect(screen.getByTitle("재생 (Space)")).toBeInTheDocument();
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
    }
  });
  it("reports the length and the selection in the status bar, and nothing shown elsewhere", async () => {
    const { container } = render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const status = container.querySelector(".studio-statusbar")!;
    expect(status).toHaveTextContent("전체 200.00초");
    expect(status).not.toHaveTextContent("fps");
    expect(status).not.toHaveTextContent("소재");
    const clip = screen.getByRole("button", { name: /^c0,/ });
    fireEvent.pointerDown(clip, { clientX: 10 });
    fireEvent.pointerUp(clip);
    expect(status).toHaveTextContent("전체 200.00초1개 선택");
  });
  it("opens the example that already exists instead of making another", async () => {
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method: string, params?: Record<string, unknown>, projectId?: string) =>
      method === "project.list"
        ? [{ id: served.id, name: served.name, updatedAt: 2 }, { id: "demo", name: "잠시, 멈추는 여행 · 예제", updatedAt: 1 }]
        : fallback(method, params, projectId));
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    fireEvent.click(screen.getByRole("button", { name: "예제 프로젝트 열기" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("project.open", { id: "demo" }, undefined));
    expect(rpc).not.toHaveBeenCalledWith("project.demo", expect.anything(), undefined);
    // Opening an example needs no announcement.
    expect(screen.queryByText(/예제 프로젝트 ·/)).toBeNull();
  });
});

describe("text and stickers from the library", () => {
  const calls = (method: string) => vi.mocked(rpc).mock.calls.filter(([name]) => name === method).map(([, params]) => params);
  it("adds to a free track, or makes a track above when every one is covered at that time", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const add = renders.libraryCommand!;
    const sticker = { mediaId: "image1", duration: 3, name: "별 스티커", transform: { scale: 0.35 } };
    // Past the last clip nothing is covered: the request goes through untouched.
    await act(async () => { await add("edit.add", { ...sticker, start: 300 }); });
    expect(calls("edit.track")).toEqual([]);
    expect(calls("edit.add")).toEqual([{ ...sticker, start: 300, expectedRevision: 1 }]);
    // At 0s all five video tracks hold a clip: the one edit.add asks for a new track (one undo step).
    vi.mocked(rpc).mockClear();
    await act(async () => { await add("edit.add", { ...sticker, start: 0, trackId: "t0", expectedRevision: 1 }); });
    expect(calls("edit.track")).toEqual([]);
    expect(calls("edit.add")).toEqual([{ ...sticker, start: 0, newTrack: "영상 6", expectedRevision: 1 }]);
    // A full-frame picture from the media tab (no transform) is not an overlay.
    vi.mocked(rpc).mockClear();
    await act(async () => { await add("edit.add", { mediaId: "image1", start: 0 }); });
    expect(calls("edit.track")).toEqual([]);
  });
  it("puts text on a text track that is free at the playhead", async () => {
    const text = (id: string, trackId: string): Clip => ({ ...clip(id, 0, trackId), kind: "text", mediaId: undefined, duration: 3 });
    const track = (id: string) => ({ id, name: id, kind: "text" as const, muted: false, hidden: false, locked: false });
    served = { ...structuredClone(base), tracks: [...base.tracks, track("x1"), track("x2")], clips: [...base.clips, text("caption", "x1")] };
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    await act(async () => { await renders.libraryCommand!("edit.add", { start: 1, duration: 3, text: { content: "제목" } }); });
    expect(calls("edit.add")).toEqual([{ start: 1, duration: 3, text: { content: "제목" }, trackId: "x2", expectedRevision: 1 }]);
    expect(calls("edit.track")).toEqual([]);
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
    // The frame size is stated once, in the player header.
    expect(screen.getByText(/1080 × 1920/)).toBeInTheDocument();
  });
  it("goes home from the logo, returns to the open project without reloading it, and opens another", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    // The mark and name in the top bar lead home.
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    fireEvent.click(await screen.findByRole("button", { name: "편집 테스트 열기" }));
    expect(await screen.findByLabelText("타임라인")).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalledWith("project.open", expect.anything(), undefined);
    // The mark and name in the top bar lead home.
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
    // With the assistant drawer in the inspector's place only the library is fitted.
    expect(fitPanelWidths({ library: 560, inspector: 520 }, 700, false)).toEqual({ library: 444, inspector: null });
    expect(fitPanelWidths({ library: null, inspector: 520 }, 700, false)).toEqual({ library: null, inspector: null });
    const fitted = fitPanelWidths({ library: 560, inspector: 520 }, 1280);
    expect(fitted.library! + fitted.inspector! + 262).toBeLessThanOrEqual(1280);
    expect(fitted.library!).toBeGreaterThanOrEqual(220);
    expect(fitted.inspector!).toBeGreaterThanOrEqual(240);
    const wide = fitPanelWidths({ library: null, inspector: 520 }, 1000);
    expect(wide.library).toBeNull();
    expect(wide.inspector! + 290 + 262).toBeLessThanOrEqual(1000);

    localStorage.setItem("byori.layout", JSON.stringify({ library: 560, inspector: 520, timeline: 300 }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The workspace is the surface plus its 6px side padding.
      const size = this.classList.contains("editing-surface") ? { width: 1280, height: 800 }
        : this.classList.contains("editor-workspace") ? { width: 1292, height: 806 } : { width: 0, height: 0 };
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

describe("this window's own edits in a row", () => {
  const CONFLICT = "프로젝트가 다른 작업에 의해 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요. (REVISION_CONFLICT)";
  /** The service's revision guard, answering each edit only when the test lets it. */
  const guardedService = () => {
    const gates: (() => void)[] = [];
    const sent: { method: string; expected: unknown }[] = [];
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (!method.startsWith("edit.")) return fallback(method, params, projectId);
      sent.push({ method, expected: params?.expectedRevision });
      await new Promise<void>((resolve) => gates.push(resolve));
      if (params?.expectedRevision !== served.revision) throw new Error(CONFLICT);
      served = { ...served, revision: served.revision + 1 };
      return structuredClone(served);
    });
    return { sent, answer: async () => { await act(async () => { gates.shift()?.(); }); } };
  };

  it("sends them one at a time, each on the revision the one before left", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const service = guardedService();
    const command = renders.libraryCommand!;
    // A move, and a trim begun before the move was answered: both were built on revision 1.
    let move!: Promise<unknown>, trim!: Promise<unknown>;
    act(() => {
      move = command("edit.batch", { commands: [{ method: "edit.update", params: { id: "c0", patch: { start: 1 } } }], expectedRevision: 1 });
      trim = command("edit.trim", { id: "c0", start: 1, end: 2, expectedRevision: 1 });
    });
    await act(async () => {});
    expect(service.sent).toEqual([{ method: "edit.batch", expected: 1 }]);
    await service.answer();
    expect(service.sent).toEqual([{ method: "edit.batch", expected: 1 }, { method: "edit.trim", expected: 2 }]);
    await service.answer();
    await expect(move).resolves.toMatchObject({ revision: 2 });
    await expect(trim).resolves.toMatchObject({ revision: 3 });
    expect(screen.queryByRole("alert")).toBeNull();
    // An edit without a revision of its own is guarded by the one on screen.
    let plain!: Promise<unknown>;
    act(() => { plain = command("edit.update", { id: "c0", patch: { start: 2 } }); });
    await act(async () => {});
    expect(service.sent[2]).toEqual({ method: "edit.update", expected: 3 });
    await service.answer();
    await expect(plain).resolves.toMatchObject({ revision: 4 });
  });

  it("still refuses an edit built on a revision somebody else has replaced", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const service = guardedService();
    const command = renders.libraryCommand!;
    let own!: Promise<unknown>;
    act(() => { own = command("edit.update", { id: "c0", patch: { start: 1 }, expectedRevision: 1 }); });
    await service.answer();
    await expect(own).resolves.toMatchObject({ revision: 2 });
    // An agent edits the project: revision 3 is not this window's.
    served = { ...served, revision: 3 };
    let stale!: Promise<unknown>, older!: Promise<unknown>;
    act(() => {
      stale = command("edit.update", { id: "c0", patch: { start: 4 }, expectedRevision: 2 });
      // Followed through this window's own 1 → 2 only, never past the agent's revision.
      older = command("edit.update", { id: "c0", patch: { start: 5 }, expectedRevision: 1 });
    });
    stale.catch(() => {});
    older.catch(() => {});
    await service.answer();
    await service.answer();
    await expect(stale).rejects.toThrow("REVISION_CONFLICT");
    await expect(older).rejects.toThrow("REVISION_CONFLICT");
    expect(service.sent.map((call) => call.expected)).toEqual([1, 2, 2]);
    expect(served.revision).toBe(3);
  });

  it("makes a repeated nudge from where the step before left the clips", async () => {
    served = { ...structuredClone(base), clips: [clip("c0", 0, "t0")] };
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const gates: (() => void)[] = [];
    const sent: unknown[] = [];
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) => {
      if (method !== "edit.batch") return fallback(method, params, projectId);
      sent.push(params);
      await new Promise<void>((resolve) => gates.push(resolve));
      if (params?.expectedRevision !== served.revision) throw new Error(CONFLICT);
      const [{ params: update }] = params.commands as { params: { id: string; patch: { start: number } } }[];
      served = {
        ...served, revision: served.revision + 1,
        clips: served.clips.map((item) => item.id === update.id ? { ...item, ...update.patch } : item),
      };
      return structuredClone(served);
    });
    const step = (start: number, expectedRevision: number) =>
      ({ commands: [{ method: "edit.update", params: { id: "c0", patch: { start } } }], expectedRevision });
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    // The key repeats before the service has answered the first step.
    fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true, repeat: true });
    await act(async () => {});
    expect(sent).toEqual([step(1 / 30, 1)]);
    await act(async () => { gates.shift()!(); });
    expect(sent).toEqual([step(1 / 30, 1), step(2 / 30, 2)]);
    await act(async () => { gates.shift()!(); });
    expect(served.clips[0].start).toBeCloseTo(2 / 30);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves a project only after the edits before it, and sends none made for it afterwards", async () => {
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    const service = guardedService();
    const command = renders.libraryCommand!;
    const opened = () => vi.mocked(rpc).mock.calls.filter(([method]) => method === "project.open").length;
    let first!: Promise<unknown>, second!: Promise<unknown>, open!: Promise<unknown>, late!: Promise<unknown>;
    act(() => {
      first = command("edit.update", { id: "c0", patch: { start: 1 } });
      second = command("edit.delete", { ids: ["c1"] });
      open = command("project.open", { id: "other" });
      // Still made for the project that is being left.
      late = command("edit.delete", { ids: ["c2"] });
    });
    await act(async () => {});
    expect(service.sent).toHaveLength(1);
    expect(opened()).toBe(0);
    await service.answer();
    // The second edit reaches the project it was made for before that is left.
    expect(service.sent).toEqual([{ method: "edit.update", expected: 1 }, { method: "edit.delete", expected: 2 }]);
    expect(opened()).toBe(0);
    await service.answer();
    await expect(first).resolves.toMatchObject({ revision: 2 });
    await expect(second).resolves.toMatchObject({ revision: 3 });
    await expect(open).resolves.toMatchObject({ id: "other" });
    expect(opened()).toBe(1);
    await expect(late).resolves.toBeUndefined();
    expect(service.sent).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows only an unbroken chain of this window's revisions", async () => {
    const { OwnRevisions } = await import("./App");
    const own = new OwnRevisions();
    own.record("p", 1, 2);
    own.record("p", 2, 3);
    // 3 → 4 was somebody else's; 4 → 5 is ours again.
    own.record("p", 4, 5);
    expect(own.latest("p", 1)).toBe(3);
    expect(own.latest("p", 3)).toBe(3);
    expect(own.latest("p", 4)).toBe(5);
    expect(own.latest("other", 1)).toBe(1);
    // An answer that is not exactly the next revision says nothing about who made it.
    own.record("p", 5, 7);
    expect(own.latest("p", 5)).toBe(5);
    own.record("other", 1, 2);
    expect(own.latest("p", 1)).toBe(1);
  });
});

describe("assistant drawer and the player's room", () => {
  const open = async (workspace: number) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const size = this.classList.contains("editor-workspace") ? { width: workspace + 12, height: 700 }
        : this.classList.contains("editing-surface") ? { width: workspace, height: 694 } : { width: 0, height: 0 };
      return { left: 0, top: 0, right: size.width, bottom: size.height, x: 0, y: 0, ...size, toJSON: () => ({}) };
    });
    const fallback = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, params, projectId) =>
      method === "agent.list" ? [] : method === "memory.search" ? { items: [] } : fallback(method, params, projectId));
    render(<App />);
    await screen.findByLabelText("프로젝트 이름");
    fireEvent.click(screen.getByText("어시스턴트", { selector: "button" }));
    await act(async () => {});
    return {
      upper: document.querySelector<HTMLElement>(".upper-workspace")!,
      workspace: document.querySelector<HTMLElement>(".editor-workspace")!,
    };
  };

  it("decides by the width the player is left with", async () => {
    const { drawerLayout } = await import("./App");
    const untouched = { library: null, inspector: 278 };
    // Unmeasured: nothing is hidden.
    expect(drawerLayout(untouched, 0)).toEqual({ inspector: true, overlay: false });
    expect(drawerLayout(untouched, 1600)).toEqual({ inspector: true, overlay: false });
    // A 1180px window: the player would be 298px beside both; without the inspector it has 556px.
    expect(drawerLayout(untouched, 1168)).toEqual({ inspector: false, overlay: false });
    // Too narrow even then: the drawer floats and the surface keeps its layout.
    expect(drawerLayout(untouched, 908)).toEqual({ inspector: true, overlay: true });
    // Wide panels the user chose count too.
    expect(drawerLayout({ library: 560, inspector: 520 }, 1900)).toEqual({ inspector: true, overlay: false });
    expect(drawerLayout({ library: 560, inspector: 278 }, 1500)).toEqual({ inspector: false, overlay: false });
  });

  it("folds the inspector away at 1180px and brings it back from the top bar", async () => {
    const { upper, workspace } = await open(1168);
    expect(upper).toHaveClass("inspector-hidden");
    expect(workspace).not.toHaveClass("drawer-overlay");
    expect(document.querySelector(".assistant-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("속성 패널 열기"));
    expect(upper).not.toHaveClass("inspector-hidden");
    expect(document.querySelector(".assistant-panel")).toBeNull();
    expect(screen.queryByLabelText("속성 패널 열기")).toBeNull();
    // The button that was pressed is gone: focus is on the panel it opened.
    expect(screen.getByLabelText("속성")).toHaveFocus();
  });

  it("floats the drawer over a window too narrow for it, and leaves a wide one alone", async () => {
    const narrow = await open(908);
    expect(narrow.workspace).toHaveClass("drawer-overlay");
    expect(narrow.upper).not.toHaveClass("inspector-hidden");
    expect(screen.queryByLabelText("속성 패널 열기")).toBeNull();
    // The inspector lies under the drawer: nothing in it takes focus.
    expect(screen.getByLabelText("속성")).toHaveAttribute("inert");
    cleanup();
    vi.restoreAllMocks();
    const wide = await open(1600);
    expect(wide.workspace).not.toHaveClass("drawer-overlay");
    expect(wide.upper).not.toHaveClass("inspector-hidden");
    expect(screen.getByLabelText("속성")).not.toHaveAttribute("inert");
  });
});
