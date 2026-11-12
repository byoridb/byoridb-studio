import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import TimelineView from "./Timeline";
import { sent } from "../test/commands";
import { playbackClock } from "./playbackClock";
import type { Clip, Command, Project } from "./types";

/**
 * The timeline as the app mounts it: an edit given as a function is made from the
 * project and sent on its revision (the app's edit queue), so `onCommand` records
 * what reaches the service.
 */
const Timeline = (props: Omit<React.ComponentProps<typeof TimelineView>, "onCommand"> & { onCommand: Command }) =>
  <TimelineView {...props} onCommand={sent(props.onCommand, () => props.project)} />;

const assetUrl = vi.hoisted(() => vi.fn((id: string) => `/${id}`));
vi.mock("./api", () => ({ assetUrl }));

const clip = (id: string, start: number, extra: Partial<Clip> = {}): Clip => ({
  id, name: id, kind: "image", mediaId: "media", trackId: "v1", start, duration: 2, sourceIn: 0, speed: 1, reverse: false,
  volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [], ...extra,
});
const track = (id: string, kind: "video" | "audio" | "text" = "video") => ({ id, name: id, kind, muted: false, hidden: false, locked: false });
const fixture = (clips: Clip[], tracks = [track("v1"), track("v2")]): Project => ({
  id: "p", name: "test", revision: 7, width: 1920, height: 1080, fps: 30, background: "#000000",
  media: [
    { id: "media", name: "image", kind: "image", duration: 5, width: 1920, height: 1080, path: "/tmp/image.png", hasAudio: false },
    { id: "film", name: "film", kind: "video", duration: 60, width: 1920, height: 1080, path: "/tmp/film.mp4", hasAudio: true },
  ],
  tracks, clips, markers: [], concept: { audience: "", message: "", appeal: "", direction: "" }, notes: [], updatedAt: "",
});
/** 500 clips: five tracks of a hundred back-to-back two-second clips (200 seconds). */
const large = () => fixture(
  Array.from({ length: 500 }, (_, index) => clip(`c${index}`, Math.floor(index / 5) * 2, { trackId: `t${index % 5}` })),
  Array.from({ length: 5 }, (_, index) => track(`t${index}`)),
);
const mount = (overrides: Partial<React.ComponentProps<typeof Timeline>> = {}) => {
  const props = {
    project: fixture([clip("a", 0), clip("b", 2), clip("c", 6)]),
    onTime: vi.fn(),
    selectedId: null,
    selectedIds: [] as string[],
    onSelection: vi.fn(),
    onCommand: vi.fn().mockResolvedValue(undefined) as Command,
    history: { canUndo: false, canRedo: false },
    ...overrides,
  };
  return { props, ...render(<Timeline {...props} />) };
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  act(() => playbackClock.seek(0));
});

describe("timeline with a large project", () => {
  it("draws only the clips near the scrolled window and never re-renders them for playback frames", () => {
    const { container } = mount({ project: large(), playing: true });
    const drawn = container.querySelectorAll(".timeline-clip").length;
    const nodes = container.querySelectorAll("*").length;
    // jsdom has no layout: the window is assumed to be 1024px wide (+600px margin) at 68px/s.
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThanOrEqual(65);
    expect(nodes).toBeLessThan(1800);
    const thumbnails = assetUrl.mock.calls.length;
    expect(thumbnails).toBe(drawn);
    const playhead = container.querySelector<HTMLElement>(".playhead")!;
    for (let frame = 1; frame <= 120; frame++) act(() => playbackClock.set(frame / 60));
    // Two seconds of playback moved the playhead only; the timecode lives in the player.
    expect(playhead.style.left).toBe(`${2 * 68}px`);
    expect(container.querySelector(".track-label-spacer")).toBeEmptyDOMElement();
    expect(assetUrl.mock.calls.length).toBe(thumbnails);
    expect(container.querySelectorAll(".timeline-clip").length).toBe(drawn);
    console.info(`[perf] timeline 500 clips: ${drawn} clip elements, ${nodes} DOM nodes, 0 clip re-renders over 120 playback frames`);
  });
  it("follows scrolling and keeps a selected off-screen clip mounted", () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    try {
      const { container } = mount({ project: large(), selectedIds: ["c499"], selectedId: "c499" });
      const names = () => Array.from(container.querySelectorAll(".clip-body")).map((element) => element.getAttribute("aria-label")!.split(",")[0]);
      expect(names()).toContain("c0");
      expect(names()).toContain("c499");
      expect(names()).not.toContain("c300");
      const workspace = container.querySelector<HTMLElement>(".timeline-workspace")!;
      Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 900 });
      workspace.scrollLeft = 120 * 68;
      fireEvent.scroll(workspace);
      act(() => frame?.(0));
      expect(names()).toContain("c300");
      expect(names()).not.toContain("c0");
      expect(names()).toContain("c499");
      expect(container.querySelectorAll(".timeline-clip").length).toBeLessThanOrEqual(100);
    } finally {
      raf.mockRestore();
    }
  });
  it("derives the split state from the clock without a time prop", () => {
    const { props } = mount({ selectedIds: ["a"], selectedId: "a" });
    const split = screen.getByRole("button", { name: "나누기" });
    expect(split).toBeDisabled();
    // The reason is on the button, not in a standing line of text.
    expect(split).toHaveAttribute("title", "나누기 (⌘B) · 재생 헤드를 클립 안으로 옮기세요 · 양쪽 1프레임 이상");
    act(() => playbackClock.seek(1));
    expect(split).toBeEnabled();
    expect(split).toHaveAttribute("title", "나누기 (⌘B)");
    fireEvent.click(split);
    expect(props.onCommand).toHaveBeenCalledWith("edit.batch", { commands: [{ method: "edit.split", params: { id: "a", time: 1 } }], expectedRevision: 7 });
  });
});

describe("timeline transitions", () => {
  it("adds a transition between touching clips as one batch and shows the overlap afterwards", () => {
    const { props, container, rerender } = mount();
    expect(screen.queryByRole("button", { name: /b → c 전환/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "a → b 전환" }));
    fireEvent.change(screen.getByLabelText("전환 종류"), { target: { value: "wipeLeft" } });
    expect(props.onCommand).toHaveBeenCalledWith("edit.batch", {
      expectedRevision: 7,
      commands: [
        { method: "edit.update", params: { id: "b", patch: { transitionIn: { type: "wipeLeft", duration: 0.5 } } } },
        // One ripple command for the later clip and everything after it.
        { method: "edit.shift", params: { trackId: "v1", from: 2, delta: -0.5 } },
      ],
    });
    const project = fixture([clip("a", 0), clip("b", 1.5, { transitionIn: { type: "wipeLeft", duration: 0.5 } }), clip("c", 5.5)]);
    rerender(<Timeline {...props} project={project} />);
    expect(container.querySelector<HTMLElement>(".clip-overlap.has-transition")!.style.width).toBe(`${0.5 * 68}px`);
    expect(screen.getByRole("button", { name: "a → b 전환 · 왼쪽 와이프" })).toHaveAttribute("aria-expanded", "true");
    vi.mocked(props.onCommand).mockClear();
    const duration = screen.getByLabelText("전환 길이(초)");
    fireEvent.change(duration, { target: { value: "1" } });
    fireEvent.blur(duration);
    expect(vi.mocked(props.onCommand).mock.calls[0][1]).toMatchObject({ commands: [
      { params: { id: "b", patch: { transitionIn: { type: "wipeLeft", duration: 1 } } } },
      { method: "edit.shift", params: { trackId: "v1", from: 1.5, delta: -0.5 } },
    ] });
    vi.mocked(props.onCommand).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "전환 제거" }));
    expect(vi.mocked(props.onCommand).mock.calls[0][1]).toMatchObject({ commands: [
      { params: { id: "b", patch: { transitionIn: null } } },
      { method: "edit.shift", params: { trackId: "v1", from: 1.5, delta: 0.5 } },
    ] });
    expect(screen.queryByLabelText("전환 종류")).toBeNull();
  });
  it("offers only a fade between audio clips and nothing on a locked track", () => {
    const tracks = [{ ...track("a1", "audio") }, { ...track("v1"), locked: true }];
    const project = fixture([
      clip("s1", 0, { kind: "audio", trackId: "a1" }), clip("s2", 2, { kind: "audio", trackId: "a1" }),
      clip("a", 0), clip("b", 2),
    ], tracks);
    mount({ project });
    expect(screen.getByRole("button", { name: "a → b 전환" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "s1 → s2 전환" }));
    const options = Array.from(screen.getByLabelText("전환 종류").querySelectorAll("option")).map((option) => option.value);
    expect(options).toEqual(["", "fade"]);
  });
});

describe("timeline context menus", () => {
  it("offers clip actions and sends a revision-guarded freeze frame at the playhead", async () => {
    const project = fixture([clip("film", 0, { kind: "video", mediaId: "film", duration: 4 }), clip("b", 6)]);
    const still = clip("still", 1, { kind: "image" });
    const onCommand = vi.fn().mockResolvedValue({ ...project, clips: [...project.clips, still] });
    const onCopy = vi.fn(), onPaste = vi.fn();
    act(() => playbackClock.seek(1));
    const { props } = mount({ project, onCommand, onCopy, onPaste, canPaste: false, selectedIds: ["film"], selectedId: "film" });
    const body = screen.getByRole("button", { name: /^film,/ });
    fireEvent.contextMenu(body, { clientX: 40, clientY: 50 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("40px");
    expect(screen.getByRole("menuitem", { name: /재생 헤드에 붙여넣기/ })).toBeDisabled();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /^복사/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /잘라내기/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^복사/ }));
    expect(onCopy).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(body, { clientX: 40, clientY: 50 });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "재생 헤드에 정지 프레임 넣기" })); });
    expect(onCommand).toHaveBeenCalledWith("edit.freeze", { id: "film", time: 1, expectedRevision: 7 });
    expect(props.onSelection).toHaveBeenLastCalledWith(["still"], "still");
    fireEvent.contextMenu(body, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: /재생 헤드에서 나누기/ }));
    expect(onCommand).toHaveBeenCalledWith("edit.batch", { commands: [{ method: "edit.split", params: { id: "film", time: 1 } }], expectedRevision: 7 });
  });
  it("selects an unselected clip, disables freeze outside a video clip, and closes with Escape", () => {
    const { props } = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^b,/ }), { clientX: 10, clientY: 10 });
    expect(props.onSelection).toHaveBeenCalledWith(["b"], "b");
    expect(screen.getByRole("menuitem", { name: "재생 헤드에 정지 프레임 넣기" })).toBeDisabled();
    const windowKey = vi.fn();
    window.addEventListener("keydown", windowKey);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    window.removeEventListener("keydown", windowKey);
    expect(windowKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("pastes and adds a marker at the clicked time on an empty track and manages tracks from the label", () => {
    const onPaste = vi.fn();
    const { props, container } = mount({ onPaste, canPaste: true });
    const row = container.querySelector('[data-track-id="v2"]')!;
    fireEvent.contextMenu(row, { clientX: 136, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: /여기에 붙여넣기/ }));
    expect(onPaste).toHaveBeenCalledWith(2);
    fireEvent.contextMenu(row, { clientX: 136, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: /마커 추가/ }));
    expect(props.onCommand).toHaveBeenCalledWith("edit.marker", { time: 2, label: "마커 1", expectedRevision: 7 });
    fireEvent.contextMenu(container.querySelectorAll(".track-label")[1], { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "트랙 삭제" }));
    expect(props.onCommand).toHaveBeenCalledWith("edit.trackDelete", { id: "v2", expectedRevision: 7 });
    fireEvent.contextMenu(container.querySelectorAll(".track-label")[1], { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "오디오 트랙 추가" }));
    expect(props.onCommand).toHaveBeenCalledWith("edit.track", { kind: "audio", name: "오디오 1", expectedRevision: 7 });
    // The secondary button never seeks or clears the selection.
    vi.mocked(props.onTime).mockClear();
    fireEvent.pointerDown(row, { button: 2, clientX: 136 });
    expect(props.onTime).not.toHaveBeenCalled();
  });
});

describe("timeline markers and loop", () => {
  it("opens the marker editor from the keyboard", () => {
    const project = fixture([clip("a", 0)]);
    project.markers = [{ id: "m1", time: 1, label: "인트로" }];
    mount({ project });
    const marker = screen.getByRole("button", { name: "마커 인트로" });
    fireEvent.keyDown(marker, { key: "Enter" });
    expect(screen.getByLabelText("마커 이름")).toHaveValue("인트로");
    expect(marker).toHaveAttribute("aria-expanded", "true");
  });
  it("marks the repeated range by ⌥-dragging the ruler, without scrubbing", () => {
    const onLoop = vi.fn();
    const { props, container } = mount({ onLoop });
    const ruler = container.querySelector(".timeline-ruler")!;
    fireEvent.pointerDown(ruler, { clientX: 136, altKey: true });
    fireEvent.pointerMove(ruler, { clientX: 68, altKey: true });
    expect(onLoop).toHaveBeenLastCalledWith({ start: 1, end: 2 });
    fireEvent.pointerUp(ruler);
    fireEvent.pointerMove(ruler, { clientX: 300 });
    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(props.onTime).not.toHaveBeenCalled();
  });
  it("remembers zoom and snapping for each project", () => {
    const first = mount();
    fireEvent.click(screen.getByTitle("타임라인 확대"));
    fireEvent.click(screen.getByTitle("스냅 켜기/끄기"));
    first.unmount();
    const other = { ...fixture([clip("a", 0)]), id: "other" };
    const second = mount();
    expect(screen.getByTitle("스냅 켜기/끄기")).toHaveAttribute("aria-pressed", "false");
    expect(second.container.querySelector<HTMLElement>(".timeline-clip")!.style.width).toBe(`${2 * 68 * 1.25}px`);
    // Another project starts from the defaults; coming back restores the stored view.
    second.rerender(<Timeline {...second.props} project={other} />);
    expect(screen.getByTitle("스냅 켜기/끄기")).toHaveAttribute("aria-pressed", "true");
    expect(second.container.querySelector<HTMLElement>(".timeline-clip")!.style.width).toBe(`${2 * 68}px`);
    second.rerender(<Timeline {...second.props} />);
    expect(screen.getByTitle("스냅 켜기/끄기")).toHaveAttribute("aria-pressed", "false");
  });
  it("lists the shortcuts in one popover instead of standing hints", () => {
    const { container } = mount();
    expect(container.querySelector(".timeline-footer, .timeline-edit-guide, .timeline-title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "단축키" }));
    expect(screen.getByRole("dialog", { name: "단축키" })).toHaveTextContent("재생 헤드에서 나누기");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "단축키" })).toBeNull();
  });
  it("closes the shortcut popover with Escape without letting the editor clear the selection", () => {
    mount();
    // Stands in for App's window key handler, whose Escape clears the selection.
    const editor = vi.fn();
    window.addEventListener("keydown", editor);
    try {
      const toggle = screen.getByRole("button", { name: "단축키" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).not.toHaveAttribute("aria-controls");
      toggle.focus();
      fireEvent.click(toggle);
      const popover = screen.getByRole("dialog", { name: "단축키" });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAttribute("aria-controls", popover.id);
      expect(popover).toHaveFocus();
      fireEvent.keyDown(popover, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "단축키" })).toBeNull();
      expect(editor).not.toHaveBeenCalled();
      expect(toggle).toHaveFocus();
      // Other keys still reach the editor while it is open, and Escape does once it is closed.
      fireEvent.click(toggle);
      fireEvent.keyDown(document.body, { key: "m" });
      expect(editor).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("dialog", { name: "단축키" })).toBeNull();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(editor).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", editor);
    }
  });
  it("shows only the switches that apply to each kind of track and one line per text clip", () => {
    const project = fixture(
      [clip("a", 0), clip("t", 0, { kind: "text", trackId: "t1", mediaId: undefined, text: { content: "자막" } as Clip["text"] })],
      [track("v1"), track("a1", "audio"), track("t1", "text")],
    );
    const { container } = mount({ project });
    const names = Array.from(container.querySelectorAll(".track-switches button")).map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["v1 잠금", "v1 표시", "v1 음소거", "a1 잠금", "a1 음소거", "t1 잠금", "t1 표시"]);
    expect(container.querySelector(".clip-text-preview")).toBeNull();
    expect(container.querySelectorAll(".timeline-marker-line")).toHaveLength(0);
  });
  it("draws the repeated range on the ruler", () => {
    const { container } = mount({ loop: { start: 1, end: 3 } });
    const band = container.querySelector<HTMLElement>(".timeline-loop")!;
    expect(band.style.left).toBe("68px");
    expect(band.style.width).toBe("136px");
  });
});
