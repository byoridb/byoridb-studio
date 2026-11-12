import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Player from "./Player";
import { rpc } from "./api";
import { playbackClock } from "./playbackClock";
import type { Clip, Project } from "./types";

vi.mock("./api", () => ({
  assetUrl: (id: string, variant?: boolean | "proxy") => `http://studio/${id}${variant === "proxy" ? "/proxy" : ""}`,
  rpc: vi.fn().mockRejectedValue(new Error("no service")),
}));
vi.mock("./assetCatalog", () => ({ useProjectFonts: vi.fn() }));

const clip = (id: string, start: number, extra: Partial<Clip> = {}): Clip => ({
  id, kind: "video", mediaId: "film", trackId: "v", name: id, start, duration: 2, sourceIn: 0, speed: 1, reverse: false,
  volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [], ...extra,
});
const fixture = (clips: Clip[], extra: Partial<Project> = {}): Project => ({
  id: "p", name: "Test", revision: 1, width: 1920, height: 1080, fps: 30, background: "#000000", clips,
  media: [
    { id: "film", name: "film", path: "/film.mp4", kind: "video", duration: 2000, width: 1920, height: 1080, hasAudio: true },
    { id: "photo", name: "photo", path: "/photo.png", kind: "image", duration: 5, width: 1000, height: 1000, hasAudio: false },
  ],
  tracks: [
    { id: "v", name: "V", kind: "video", muted: false, hidden: false, locked: false },
    { id: "t", name: "T", kind: "text", muted: false, hidden: false, locked: false },
  ],
  markers: [], notes: [], concept: { audience: "", message: "", appeal: "", direction: "" }, updatedAt: 1, ...extra,
});
const mount = (project: Project, extra: Partial<React.ComponentProps<typeof Player>> = {}) => {
  const props = { project, playing: false, onTime: vi.fn(), onPlaying: vi.fn(), selectedId: null, onSelect: vi.fn(), onCommand: vi.fn(), ...extra };
  return { props, ...render(<Player {...props} />) };
};
const layer = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  act(() => playbackClock.seek(0));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("player with a large project", () => {
  it("mounts media elements only near the playhead while following the clock", async () => {
    // 500 back-to-back two-second video cuts: 1000 seconds.
    const project = fixture(Array.from({ length: 500 }, (_, index) => clip(`c${index}`, index * 2, { sourceIn: index * 2 })));
    const { container } = mount(project, { playing: true });
    const mounted = () => Array.from(container.querySelectorAll("video")).map((element) => element.dataset.clipId);
    expect(mounted()).toEqual(["c0", "c1", "c2"]);
    let most = mounted().length;
    for (let frame = 1; frame <= 300; frame++) {
      act(() => playbackClock.set(frame / 30));
      most = Math.max(most, mounted().length);
    }
    // Ten seconds in: the clip that just ended has gone, the next cuts are waiting.
    expect(screen.getByText("00:00:10:00")).toBeInTheDocument();
    expect(mounted()).toEqual(["c4", "c5", "c6", "c7"]);
    expect(most).toBeLessThanOrEqual(5);
    const nodes = container.querySelectorAll(".composition *").length;
    expect(nodes).toBeLessThan(20);
    expect(container.querySelector<HTMLVideoElement>('[data-clip-id="c5"]')!.preload).toBe("auto");
    expect(container.querySelector<HTMLVideoElement>('[data-clip-id="c7"]')!.preload).toBe("metadata");
    expect(layer(container, "c6").style.display).toBe("none");
    expect(layer(container, "c5").style.display).toBe("");
    console.info(`[perf] player 500 clips: at most ${most} video elements, ${nodes} composition DOM nodes over 300 playback frames`);
    await act(async () => {});
  });
  it("plays the proxy copy when one exists and returns to the original if it fails", async () => {
    const project = fixture([clip("a", 0)]);
    project.media[0].proxy = true;
    const { container, props } = mount(project);
    const video = () => container.querySelector("video")!;
    expect(video().getAttribute("src")).toBe("http://studio/film/proxy");
    fireEvent.error(video());
    expect(video().getAttribute("src")).toBe("http://studio/film");
    expect(props.onPlaying).not.toHaveBeenCalled();
    cleanup();
    project.media[0].proxy = false;
    const plain = mount(project);
    expect(plain.container.querySelector("video")!.getAttribute("src")).toBe("http://studio/film");
    await act(async () => {});
  });
  it("marks a paused frame drawn from proxies and redraws it from the originals on request", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(rpc).mockImplementation(async (_method, params) => ({
        assetId: (params as { proxy?: boolean }).proxy === false ? "original" : "light",
        revision: 1,
        projectId: "p",
        proxies: (params as { proxy?: boolean }).proxy === false ? 0 : 1,
      }));
      const project = fixture([clip("a", 0)]);
      project.media[0].proxy = true;
      const { container } = mount(project);
      const toggle = screen.getByRole("button", { name: "원본으로 보기" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByText("프록시")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(container.querySelector("img.rendered-preview")).toHaveAttribute("src", "http://studio/light");
      expect(screen.getByText("프록시")).toHaveAttribute("title", expect.stringContaining("프록시 1개"));
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(rpc).toHaveBeenLastCalledWith("preview.frame", expect.objectContaining({ proxy: false, client: "player" }), "p");
      expect(container.querySelector("img.rendered-preview")).toHaveAttribute("src", "http://studio/original");
      expect(screen.queryByText("프록시")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("offers no originals switch when the project has no proxy", async () => {
    mount(fixture([clip("a", 0)]));
    expect(screen.queryByRole("button", { name: "원본으로 보기" })).toBeNull();
    expect(screen.queryByText("프록시")).toBeNull();
    await act(async () => {});
  });
});

describe("fast preview approximation", () => {
  it("stacks an overlapping later clip above the earlier one and applies its transition", async () => {
    const project = fixture([
      clip("late", 1.5, { kind: "image", mediaId: "photo", transitionIn: { type: "dissolve", duration: 1 } }),
      clip("early", 0, { kind: "image", mediaId: "photo" }),
    ]);
    const { container } = mount(project, { time: 1.75 });
    const order = Array.from(container.querySelectorAll<HTMLElement>(".composition-layer")).map((element) => element.dataset.layerId);
    expect(order).toEqual(["early", "late"]);
    expect(layer(container, "late").style.opacity).toBe("0.25");
    expect(layer(container, "early").style.opacity).toBe("1");
  });
  it("slides and zooms through the layer transform and eases keyframes", () => {
    const project = fixture([
      clip("slide", 0, { kind: "image", mediaId: "photo", transitionIn: { type: "slideLeft", duration: 2 } }),
      clip("zoom", 0, { kind: "image", mediaId: "photo", transitionOut: { type: "zoom", duration: 2 } }),
      clip("eased", 0, { kind: "image", mediaId: "photo", keyframes: [{ property: "x", time: 0, value: 0, easing: "easeIn" }, { property: "x", time: 2, value: 960 }] }),
    ]);
    const { container } = mount(project, { time: 1 });
    const scale = 640 / 1920;
    // Half way in: half of (frame width + the 1080 px wide fitted photo) / 2, as in the export.
    expect(layer(container, "slide").style.transform).toContain(`translate(${750 * scale}px,0px)`);
    expect(layer(container, "zoom").style.transform).toContain("scale(0.9)");
    expect(layer(container, "zoom").style.opacity).toBe("0.5");
    expect(layer(container, "eased").style.transform).toContain(`translate(${240 * scale}px,0px)`);
  });
  it("fits a cropped source and flips inside its frame", () => {
    const project = fixture([clip("crop", 0, { kind: "image", mediaId: "photo", crop: { x: 0.5, y: 0, width: 0.5, height: 1 }, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: true } })]);
    const { container } = mount(project, { time: 0 });
    const frame = container.querySelector<HTMLElement>(".layer-frame")!;
    // A 1000×1000 source cropped to its right half, fitted into 640×360.
    expect(frame.style.width).toBe("180px");
    expect(frame.style.height).toBe("360px");
    const image = frame.querySelector("img")!;
    expect(image.style.width).toBe("360px");
    expect(image.style.left).toBe("-180px");
    expect(image.style.transform).toBe("scale(-1,1)");
    expect(layer(container, "crop").style.transform).not.toContain("scale(-1");
  });
  it("lays out text with the shared wrap width and optional styling", () => {
    const text = clip("title", 0, { kind: "text", mediaId: undefined, trackId: "t", text: { content: "긴 제목", fontSize: 90, color: "#fff", fontFamily: "sans-serif", bold: true, align: "center", background: "", italic: true, letterSpacing: 6, lineHeight: 1.5 } });
    const { container } = mount(fixture([text]), { time: 0 });
    const box = layer(container, "title").firstElementChild as HTMLElement;
    expect(box.style.fontSize).toBe("30px");
    expect(box.style.fontStyle).toBe("italic");
    expect(box.style.letterSpacing).toBe("2px");
    expect(box.style.lineHeight).toBe("1.5");
    expect(box.style.maxWidth).toBe(`${1920 * 0.9 * (640 / 1920)}px`);
    expect(box.style.whiteSpace).toBe("pre-wrap");
  });
});

describe("player controls", () => {
  it("applies and remembers the preview volume", async () => {
    const { container } = mount(fixture([clip("a", 0, { volume: 0.8 })]), { time: 1 });
    const video = container.querySelector("video")!;
    expect(video.volume).toBeCloseTo(0.8);
    fireEvent.change(screen.getByLabelText("미리보기 음량"), { target: { value: "0.5" } });
    expect(video.volume).toBeCloseTo(0.4);
    expect(localStorage.getItem("byori.player.volume")).toBe("0.5");
    fireEvent.click(screen.getByTitle("소리 끄기"));
    expect(video.volume).toBe(0);
    cleanup();
    const again = mount(fixture([clip("a", 0, { volume: 0.8 })]), { time: 1 });
    expect(again.container.querySelector("video")!.volume).toBeCloseTo(0.4);
    await act(async () => {});
  });
  it("zooms the stage in project pixels and returns to fit", async () => {
    const { container } = mount(fixture([clip("a", 0)]), { time: 0 });
    const stage = container.querySelector<HTMLElement>(".composition")!;
    expect(stage.style.width).toBe("640px");
    fireEvent.change(screen.getByLabelText("미리보기 확대"), { target: { value: "0.5" } });
    expect(stage.style.width).toBe("960px");
    expect(stage.style.height).toBe("540px");
    expect(container.querySelector(".player-viewport")).toHaveClass("zoomed");
    fireEvent.change(screen.getByLabelText("미리보기 확대"), { target: { value: "fit" } });
    expect(stage.style.width).toBe("640px");
    await act(async () => {});
  });
  it("repeats the selection or the whole project from one button, and switches precise playback with a toggle", async () => {
    const onLoop = vi.fn(), onPreviewMode = vi.fn();
    const project = fixture([clip("a", 0, { duration: 10 })]);
    const { rerender, props, container } = mount(project, { time: 4, onLoop, onPreviewMode });
    // One repeat control: no separate start/end buttons and no ratio chip beside it.
    expect(screen.queryByRole("button", { name: /반복 (시작점|끝점)/ })).toBeNull();
    expect(container.querySelector(".ratio-label")).toBeNull();
    const repeat = () => screen.getByRole("button", { name: "구간 반복" });
    fireEvent.click(repeat());
    expect(onLoop).toHaveBeenLastCalledWith({ start: 0, end: 10 });
    rerender(<Player {...props} time={4} loop={{ start: 0, end: 10 }} />);
    expect(repeat()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(repeat());
    expect(onLoop).toHaveBeenLastCalledWith(null);
    // With a selection the button repeats just that range.
    rerender(<Player {...props} time={4} loop={null} loopTarget={{ start: 2, end: 6 }} />);
    fireEvent.click(repeat());
    expect(onLoop).toHaveBeenLastCalledWith({ start: 2, end: 6 });
    const precise = screen.getByRole("button", { name: "정밀 재생" });
    expect(precise).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(precise);
    expect(onPreviewMode).toHaveBeenLastCalledWith("precise");
    rerender(<Player {...props} time={4} previewMode="precise" />);
    fireEvent.click(screen.getByRole("button", { name: "정밀 재생" }));
    expect(onPreviewMode).toHaveBeenLastCalledWith("fast");
    await act(async () => {});
  });
  it("fits the frame to the screen in fullscreen, so text scales with it", async () => {
    const text = clip("title", 0, { kind: "text", mediaId: undefined, trackId: "t", text: { content: "제목", fontSize: 96, color: "#fff", fontFamily: "sans-serif", bold: false, align: "center", background: "" } });
    const { container } = mount(fixture([text]), { time: 0 });
    const viewport = container.querySelector<HTMLElement>(".player-viewport")!;
    const request = vi.fn().mockResolvedValue(undefined);
    viewport.requestFullscreen = request;
    fireEvent.click(screen.getByTitle("미리보기 전체 화면"));
    expect(request).toHaveBeenCalledOnce();
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, x: 0, y: 0, toJSON: () => ({}) });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => viewport });
    try {
      act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
      expect(container.querySelector<HTMLElement>(".composition")!.style.width).toBe("1920px");
      expect((layer(container, "title").firstElementChild as HTMLElement).style.fontSize).toBe("96px");
    } finally {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    }
  });
});
