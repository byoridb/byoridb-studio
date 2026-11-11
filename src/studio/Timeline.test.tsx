import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Timeline from "./Timeline";
import {
  clipGroup,
  moveSelection,
  moveSelectionToTrack,
  shiftSelectionTracks,
  toggleSelection,
} from "./selection";
import type { Clip, Command, Project } from "./types";

vi.mock("./api", () => ({ assetUrl: (id: string) => `/${id}` }));
const clip = (id: string, start: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  name: id,
  kind: "image",
  mediaId: "media",
  trackId: "v1",
  start,
  duration: 2,
  sourceIn: 0,
  speed: 1,
  reverse: false,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  keyframes: [],
  ...extra,
});

describe("timeline layers", () => {
  it("selects empty layers and selects a newly created layer for the next insert", async () => {
    const project = fixture();
    const created = { id: "text-new", name: "자막·텍스트 1", kind: "text", muted: false, hidden: false, locked: false };
    const command = vi.fn().mockResolvedValue({ ...project, tracks: [...project.tracks, created] });
    const onTrackSelect = vi.fn();
    render(<Harness command={command} onTrackSelect={onTrackSelect} selectedTrackId="v2" />);
    expect(screen.getByRole("button", { name: "영상 2 트랙 선택" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerDown(screen.getByLabelText("영상 1 트랙"), { clientX: 100 });
    expect(onTrackSelect).toHaveBeenLastCalledWith("v1");
    fireEvent.change(screen.getByRole("combobox", { name: "트랙 추가" }), { target: { value: "text" } });
    await waitFor(() => expect(onTrackSelect).toHaveBeenLastCalledWith("text-new"));
  });
  it("creates separate video, audio and subtitle tracks", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} />);
    const control = screen.getByRole("combobox", { name: "트랙 추가" });
    fireEvent.change(control, { target: { value: "video" } });
    fireEvent.change(control, { target: { value: "audio" } });
    fireEvent.change(control, { target: { value: "text" } });
    expect(command.mock.calls).toEqual([
      ["edit.track", { kind: "video", name: "영상 3", expectedRevision: 7 }],
      ["edit.track", { kind: "audio", name: "오디오 1", expectedRevision: 7 }],
      ["edit.track", { kind: "text", name: "자막·텍스트 1", expectedRevision: 7 }],
    ]);
  });
  it("moves selected clips without changing their timing and can split them to a new layer atomically", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} initial={["a", "b"]} />);
    const control = screen.getByRole("combobox", { name: "선택 클립 트랙 이동" });
    fireEvent.change(control, { target: { value: "v2" } });
    expect(command).toHaveBeenCalledWith("edit.batch", { expectedRevision: 7, commands: [
      { method: "edit.update", params: { id: "a", patch: { trackId: "v2" } } },
      { method: "edit.update", params: { id: "b", patch: { trackId: "v2" } } },
    ] });
    fireEvent.change(control, { target: { value: "new" } });
    expect(command).toHaveBeenCalledWith("edit.track", { kind: "video", name: "영상 3", clipIds: ["a", "b"], expectedRevision: 7 });
  });
  it("allows vertical dragging between compatible rows and keeps a locked destination unchanged", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    render(<Harness project={project} command={command} initial={["a"]} />);
    for (const [name, top] of [["영상 1", 100], ["영상 2", 172]] as const) {
      vi.spyOn(screen.getByLabelText(`${name} 트랙`), "getBoundingClientRect").mockReturnValue({ top, bottom: top + 72, left: 0, right: 1000, width: 1000, height: 72, x: 0, y: top, toJSON: () => ({}) });
    }
    fireEvent.pointerDown(item("a"), { clientX: 100, clientY: 120 });
    fireEvent.pointerMove(item("a"), { clientX: 100, clientY: 190 });
    expect(screen.getByLabelText("영상 2 트랙")).toHaveClass("layer-drop-target");
    fireEvent.pointerUp(item("a"));
    expect(command).toHaveBeenLastCalledWith("edit.batch", { expectedRevision: 7, commands: [{ method: "edit.update", params: { id: "a", patch: { start: 1, trackId: "v2" } } }] });
    command.mockClear();
    project.tracks[1].locked = true;
    fireEvent.pointerDown(item("a"), { clientX: 100, clientY: 120 });
    fireEvent.pointerMove(item("a"), { clientX: 100, clientY: 190 });
    fireEvent.pointerUp(item("a"));
    expect(command).not.toHaveBeenCalled();
  });
  it("does not move audio to video or combine mixed kinds into one layer", () => {
    const project = fixture();
    project.tracks.push({ id: "a1", kind: "audio", name: "오디오 1", muted: false, hidden: false, locked: false });
    project.clips.push(clip("music", 0, { kind: "audio", trackId: "a1" }));
    const command = vi.fn();
    render(<Harness project={project} command={command} initial={["a", "music"]} />);
    expect(screen.getByRole("combobox", { name: "선택 클립 트랙 이동" })).toBeDisabled();
    expect(moveSelectionToTrack(project, ["music"], "v2")).toEqual([]);
    expect(moveSelectionToTrack(project, ["a"], "a1")).toEqual([]);
  });
  it("keeps an existing selection spread across layers during horizontal dragging", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    project.clips[1].trackId = "v2";
    render(<Harness project={project} command={command} initial={["a", "b"]} />);
    vi.spyOn(screen.getByLabelText("영상 1 트랙"), "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 172, left: 0, right: 1000, width: 1000, height: 72, x: 0, y: 100, toJSON: () => ({}) });
    fireEvent.pointerDown(item("a"), { clientX: 100, clientY: 120 });
    fireEvent.pointerMove(item("a"), { clientX: 168, clientY: 120 });
    fireEvent.pointerUp(item("a"));
    expect(command).toHaveBeenCalledWith("edit.batch", { expectedRevision: 7, commands: [
      { method: "edit.update", params: { id: "a", patch: { start: 2 } } },
      { method: "edit.update", params: { id: "b", patch: { start: 5 } } },
    ] });
  });
  it("renames a layer with revision checking and cancels an Escape edit", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} />);
    const input = screen.getByRole("textbox", { name: "영상 1 이름" });
    fireEvent.change(input, { target: { value: "배경 영상" } });
    fireEvent.blur(input);
    expect(command).toHaveBeenCalledWith("edit.track", { id: "v1", patch: { name: "배경 영상" }, expectedRevision: 7 });
    command.mockClear();
    input.focus();
    fireEvent.change(input, { target: { value: "취소할 이름" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(command).not.toHaveBeenCalled();
    expect(input).toHaveValue("영상 1");
  });
});
const fixture = (): Project => ({
  id: "p",
  name: "test",
  revision: 7,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  media: [
    {
      id: "media",
      name: "image",
      kind: "image",
      duration: 5,
      width: 1920,
      height: 1080,
      path: "/tmp/image.png",
      hasAudio: false,
    },
  ],
  tracks: [
    {
      id: "v1",
      name: "영상 1",
      kind: "video",
      muted: false,
      hidden: false,
      locked: false,
    },
    {
      id: "v2",
      name: "영상 2",
      kind: "video",
      muted: false,
      hidden: false,
      locked: false,
    },
  ],
  clips: [clip("a", 1), clip("b", 4), clip("c", 8)],
  markers: [],
  concept: { audience: "", message: "", appeal: "", direction: "" },
  notes: [],
  updatedAt: "",
});
function Harness({
  project = fixture(),
  command = vi.fn().mockResolvedValue(undefined),
  initial = [],
  time = 0,
  selectedTrackId,
  onTrackSelect,
}: {
  project?: Project;
  command?: Command;
  initial?: string[];
  time?: number;
  selectedTrackId?: string;
  onTrackSelect?: (id: string) => void;
}) {
  const [ids, setIds] = useState(initial);
  const [primary, setPrimary] = useState<string | null>(initial[0] || null);
  return (
    <Timeline
      project={project}
      time={time}
      onTime={vi.fn()}
      selectedId={primary}
      selectedIds={ids}
      selectedTrackId={selectedTrackId}
      onTrackSelect={onTrackSelect}
      onSelection={(next, id) => {
        setIds(next);
        setPrimary(id || next[0] || null);
      }}
      onCommand={command}
      history={{ canUndo: false, canRedo: false }}
    />
  );
}
const item = (id: string) =>
  screen.getByRole("button", { name: new RegExp(`^${id},`) });
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
});

describe("timeline multiple selection", () => {
  it("toggles selection using Shift and Cmd and expands grouped clips", () => {
    const project = fixture();
    project.clips[0].groupId = "group";
    project.clips[1].groupId = "group";
    render(<Harness project={project} />);
    fireEvent.pointerDown(item("a"), { clientX: 10 });
    fireEvent.pointerUp(item("a"));
    expect(item("a")).toHaveAttribute("aria-pressed", "true");
    expect(item("b")).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerDown(item("c"), { shiftKey: true });
    expect(item("c")).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerDown(item("b"), { metaKey: true });
    expect(item("a")).toHaveAttribute("aria-pressed", "false");
    expect(item("b")).toHaveAttribute("aria-pressed", "false");
    expect(item("c")).toHaveAttribute("aria-pressed", "true");
  });
  it("moves all selected clips together as one atomic revision-guarded command", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} initial={["a", "b"]} />);
    fireEvent.click(screen.getByTitle("스냅 켜기/끄기"));
    fireEvent.pointerDown(item("b"), { clientX: 100 });
    fireEvent.pointerMove(item("b"), { clientX: 168 });
    fireEvent.pointerUp(item("b"));
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith("edit.batch", {
      expectedRevision: 7,
      commands: [
        { method: "edit.update", params: { id: "a", patch: { start: 2 } } },
        { method: "edit.update", params: { id: "b", patch: { start: 5 } } },
      ],
    });
  });
  it("clamps the earliest clip at zero while retaining the gap", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} initial={["a", "b"]} />);
    fireEvent.pointerDown(item("b"), { clientX: 300 });
    fireEvent.pointerMove(item("b"), { clientX: -500 });
    fireEvent.pointerUp(item("b"));
    expect(
      command.mock.calls[0][1].commands.map(
        (entry: { params: { patch: { start: number } } }) =>
          entry.params.patch.start,
      ),
    ).toEqual([0, 3]);
  });
  it("does not commit a cancelled drag or a plain click", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} initial={["a"]} />);
    fireEvent.pointerDown(item("a"), { clientX: 0 });
    fireEvent.pointerMove(item("a"), { clientX: 100 });
    fireEvent.pointerCancel(item("a"));
    fireEvent.pointerDown(item("a"), { clientX: 0 });
    fireEvent.pointerUp(item("a"));
    expect(command).not.toHaveBeenCalled();
  });
  it("routes duplicate, group, and ripple delete through the full selection", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness command={command} initial={["a", "b"]} />);
    fireEvent.click(screen.getByTitle("선택 복제 (⌘D)"));
    fireEvent.click(screen.getByTitle("그룹 만들기 (⌘G)"));
    fireEvent.click(screen.getByTitle("간격을 당기며 삭제 (⇧Delete)"));
    expect(command).toHaveBeenCalledWith("edit.duplicate", {
      ids: ["a", "b"],
      expectedRevision: 7,
    });
    expect(command).toHaveBeenCalledWith("edit.group", {
      ids: ["a", "b"],
      expectedRevision: 7,
    });
    expect(command).toHaveBeenCalledWith("edit.delete", {
      ids: ["a", "b"],
      ripple: true,
      expectedRevision: 7,
    });
  });
  it("keeps locked-track clips inspectable and prevents changing a selection containing them", () => {
    const project = fixture();
    project.tracks[0].locked = true;
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness project={project} command={command} />);
    fireEvent.pointerDown(item("a"), { clientX: 0 });
    fireEvent.pointerMove(item("a"), { clientX: 100 });
    fireEvent.pointerUp(item("a"));
    expect(item("a")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("선택 삭제 (Delete)")).toBeDisabled();
    expect(command).not.toHaveBeenCalled();
  });
});

describe("timeline clip editing", () => {
  it("explains selection and disables playhead actions until a clip can be cut", () => {
    const { rerender } = render(<Harness time={2} />);
    const actions = ["나누기", "앞부분 자르기", "뒷부분 자르기"];
    for (const name of actions) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("클립을 선택");
    fireEvent.keyDown(item("a"), { key: "Enter" });
    for (const name of actions) expect(screen.getByRole("button", { name })).toBeEnabled();
    rerender(<Harness time={1} />);
    for (const name of actions) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("양쪽 1프레임 이상");
  });
  it("splits and trims at the playhead with the current project revision", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness time={2} initial={["a"]} command={command} />);
    fireEvent.click(screen.getByRole("button", { name: "나누기" }));
    fireEvent.click(screen.getByRole("button", { name: "앞부분 자르기" }));
    fireEvent.click(screen.getByRole("button", { name: "뒷부분 자르기" }));
    expect(command.mock.calls).toEqual([
      ["edit.split", { id: "a", time: 2, expectedRevision: 7 }],
      ["edit.trim", { id: "a", start: 2, expectedRevision: 7 }],
      ["edit.trim", { id: "a", end: 2, expectedRevision: 7 }],
    ]);
  });
  it("cuts selected video and subtitle layers in one atomic command", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    project.tracks.push({ id: "t1", kind: "text", name: "자막 1", locked: false, muted: false, hidden: false });
    project.clips.push(clip("caption", 0, { kind: "text", trackId: "t1", duration: 4 }));
    render(<Harness project={project} time={2} initial={["a", "caption", "b"]} command={command} />);
    fireEvent.click(screen.getByRole("button", { name: "나누기" }));
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith("edit.batch", { expectedRevision: 7, commands: [
      { method: "edit.split", params: { id: "a", time: 2 } },
      { method: "edit.split", params: { id: "caption", time: 2 } },
    ] });
    expect(screen.getByRole("status")).toHaveTextContent("2개 클립");
  });
  it("selects the new right-hand piece after splitting", async () => {
    const project = fixture();
    const split = { ...project, clips: [...project.clips, clip("right", 2, { duration: 1 })] };
    const command = vi.fn().mockResolvedValue(split);
    const { rerender } = render(<Harness project={project} time={2} initial={["a"]} command={command} />);
    fireEvent.click(screen.getByRole("button", { name: "나누기" }));
    await waitFor(() => expect(item("a")).toHaveAttribute("aria-pressed", "false"));
    rerender(<Harness project={split} time={2} initial={["a"]} command={command} />);
    expect(item("right")).toHaveAttribute("aria-pressed", "true");
  });
  it("previews trim timing while dragging and commits just one edit.trim on release", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={["a"]} command={command} />);
    const handle = screen.getByRole("button", { name: "a 시작점 트림" });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 134 });
    expect(command).not.toHaveBeenCalled();
    expect(item("a")).toHaveAttribute("aria-label", "a, 1.5초, 1.5초");
    expect(screen.getByRole("status")).toHaveTextContent("길이 1.50초");
    fireEvent.pointerMove(handle, { clientX: 168 });
    fireEvent.pointerUp(handle);
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith("edit.trim", { id: "a", start: 2, end: 3, expectedRevision: 7 });
  });
  it("does not save cancelled trims or a handle returned to its original position", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={["a"]} command={command} />);
    const handle = screen.getByRole("button", { name: "a 끝점 트림" });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 32 });
    fireEvent.pointerCancel(handle);
    expect(item("a")).toHaveAttribute("aria-label", "a, 1.0초, 2.0초");
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 32 });
    fireEvent.pointerMove(handle, { clientX: 100 });
    fireEvent.pointerUp(handle);
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 32 });
    fireEvent.keyDown(handle, { key: "Escape" });
    fireEvent.pointerUp(handle);
    expect(command).not.toHaveBeenCalled();
  });
  it("clamps a drag to one frame and lets image clips extend past source duration", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={["a"]} command={command} />);
    const handle = screen.getByRole("button", { name: "a 끝점 트림" });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: -1000 });
    fireEvent.pointerUp(handle);
    expect(command.mock.calls[0][1].end - command.mock.calls[0][1].start).toBeCloseTo(1 / 30);
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 440 });
    fireEvent.pointerUp(handle);
    expect(command).toHaveBeenLastCalledWith("edit.trim", { id: "a", start: 1, end: 8, expectedRevision: 7 });
  });
  it("preserves an off-grid neighboring edge when snapping a trim drag", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    project.clips[1].start = 5.01;
    render(<Harness project={project} initial={["a"]} command={command} />);
    const handle = screen.getByRole("button", { name: "a 끝점 트림" });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 236 });
    fireEvent.pointerUp(handle);
    expect(command).toHaveBeenCalledWith("edit.trim", { id: "a", start: 1, end: 5.01, expectedRevision: 7 });
  });
  it("bounds reverse video extension by source handles, accounting for playback speed", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    project.media[0].kind = "video";
    project.media[0].duration = 12;
    project.clips[0] = clip("a", 3, { kind: "video", sourceIn: 2, speed: 2, reverse: true, duration: 3 });
    render(<Harness project={project} initial={["a"]} command={command} />);
    fireEvent.click(screen.getByTitle("스냅 켜기/끄기"));
    const handle = screen.getByRole("button", { name: "a 끝점 트림" });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 440 });
    expect(item("a")).toHaveAttribute("aria-label", "a, 3.0초, 4.0초");
    fireEvent.pointerUp(handle);
    expect(command).toHaveBeenCalledWith("edit.trim", { id: "a", start: 3, end: 7, expectedRevision: 7 });
  });
  it("supports local one-frame keyboard trims and keeps handles out of unselected clips' tab order", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={["a"]} command={command} />);
    expect(screen.getByRole("button", { name: "b 시작점 트림" })).toHaveAttribute("tabindex", "-1");
    const handle = screen.getByRole("button", { name: "a 시작점 트림" });
    expect(handle).toHaveAttribute("tabindex", "0");
    const windowKey = vi.fn();
    window.addEventListener("keydown", windowKey);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    window.removeEventListener("keydown", windowKey);
    expect(windowKey).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0][0]).toBe("edit.trim");
    expect(command.mock.calls[0][1].start).toBeCloseTo(1 + 1 / 30);
    expect(command.mock.calls[0][1].end).toBe(3);
    expect(command.mock.calls[0][1].expectedRevision).toBe(7);
  });
  it("nudges an off-grid clip edge by exactly one frame without rounding its offset", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    project.clips[0].start = 1.01;
    render(<Harness project={project} initial={["a"]} command={command} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "a 시작점 트림" }), { key: "ArrowRight" });
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0][0]).toBe("edit.trim");
    expect(command.mock.calls[0][1].start - 1.01).toBeCloseTo(1 / 30, 12);
    expect(command.mock.calls[0][1].end).toBeCloseTo(3.01, 12);
    expect(command.mock.calls[0][1].expectedRevision).toBe(7);
  });
  it("keeps editor shortcuts bubbling after a trim drag leaves the handle focused", () => {
    const command = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={["a"]} command={command} />);
    const handle = screen.getByRole("button", { name: "a 시작점 트림" });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 134 });
    fireEvent.pointerUp(handle);
    expect(handle).toHaveFocus();
    const windowKey = vi.fn((event: KeyboardEvent) => {
      if (event.key === " ") event.preventDefault();
    });
    window.addEventListener("keydown", windowKey);
    try {
      fireEvent.keyDown(handle, { key: "z", metaKey: true });
      expect(fireEvent.keyDown(handle, { key: " " })).toBe(false);
      fireEvent.keyDown(handle, { key: "b", metaKey: true });
      fireEvent.keyDown(handle, { key: "q" });
      fireEvent.keyDown(handle, { key: "w" });
      expect(windowKey.mock.calls.map(([event]) => event.key)).toEqual(["z", " ", "b", "q", "w"]);
      // These keys are handled by App; Timeline must not emit another trim.
      expect(command).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", windowKey);
    }
  });
  it("blocks all playhead edits and trim handles on a locked track", () => {
    const project = fixture(), command = vi.fn().mockResolvedValue(undefined);
    project.tracks[0].locked = true;
    render(<Harness project={project} time={2} initial={["a"]} command={command} />);
    for (const name of ["나누기", "앞부분 자르기", "뒷부분 자르기", "a 시작점 트림", "a 끝점 트림"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("트랙 잠금을 해제");
    fireEvent.keyDown(screen.getByRole("button", { name: "a 끝점 트림" }), { key: "ArrowRight" });
    expect(command).not.toHaveBeenCalled();
  });
});

describe("selection movement rules", () => {
  it("moves vertically only if every clip has an unlocked compatible destination", () => {
    const project = fixture();
    expect(shiftSelectionTracks(project, ["a", "b"], 1)).toEqual([
      { method: "edit.update", params: { id: "a", patch: { trackId: "v2" } } },
      { method: "edit.update", params: { id: "b", patch: { trackId: "v2" } } },
    ]);
    project.tracks[1].locked = true;
    expect(shiftSelectionTracks(project, ["a", "b"], 1)).toEqual([]);
  });
  it("preserves group membership and clamps shared moves", () => {
    const project = fixture();
    project.clips[0].groupId = "g";
    project.clips[1].groupId = "g";
    expect(clipGroup(project, "a")).toEqual(["a", "b"]);
    expect(toggleSelection(project, ["c"], "b")).toEqual(["c", "a", "b"]);
    expect(
      moveSelection(project.clips.slice(0, 2), -5).map(
        (command) => command.params.patch.start,
      ),
    ).toEqual([0, 3]);
  });
});

describe("timeline basics", () => {
  const mount = (overrides: Partial<React.ComponentProps<typeof Timeline>> = {}) => {
    const props = {
      project: fixture(),
      time: 0,
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
  const audioProject = (extra: Partial<Clip> = {}) => {
    const project = fixture();
    project.media.push({ id: "sound", name: "sound", kind: "audio", duration: 10, width: 0, height: 0, path: "/tmp/sound.wav", hasAudio: true, waveform: Array.from({ length: 100 }, (_, index) => index / 100) });
    project.tracks.push({ id: "a1", name: "오디오 1", kind: "audio", muted: false, hidden: false, locked: false });
    project.clips = [clip("s", 0, { kind: "audio", mediaId: "sound", trackId: "a1", duration: 2, ...extra })];
    return project;
  };

  it("lets Space reach the editor after a clip is clicked while Enter still selects", () => {
    const { props } = mount();
    fireEvent.pointerDown(item("a"), { clientX: 10 });
    fireEvent.pointerUp(item("a"));
    expect(item("a")).toHaveFocus();
    const windowKey = vi.fn();
    window.addEventListener("keydown", windowKey);
    try {
      expect(fireEvent.keyDown(item("a"), { key: " ", code: "Space" })).toBe(true);
      expect(windowKey).toHaveBeenCalledOnce();
      vi.mocked(props.onSelection).mockClear();
      fireEvent.keyDown(item("b"), { key: "Enter" });
      expect(props.onSelection).toHaveBeenCalledWith(["b"], "b");
      expect(windowKey).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", windowKey);
    }
  });

  it("scrubs while the ruler or the playhead handle is dragged, and stops on release", () => {
    const { props, container } = mount();
    const ruler = container.querySelector(".timeline-ruler")!;
    fireEvent.pointerDown(ruler, { clientX: 68 });
    fireEvent.pointerMove(ruler, { clientX: 136 });
    fireEvent.pointerUp(ruler);
    fireEvent.pointerMove(ruler, { clientX: 204 });
    expect(vi.mocked(props.onTime).mock.calls).toEqual([[1], [2]]);
    const handle = container.querySelector(".playhead-handle")!;
    fireEvent.pointerDown(handle, { clientX: 340 });
    fireEvent.pointerMove(handle, { clientX: 408 });
    fireEvent.pointerUp(handle);
    expect(vi.mocked(props.onTime).mock.calls.slice(2)).toEqual([[5], [6]]);
  });

  it("renames and deletes a marker with the current revision", () => {
    const project = fixture();
    project.markers = [{ id: "m1", time: 3, label: "도입" }];
    const { props } = mount({ project });
    const marker = screen.getByRole("button", { name: "마커 도입" });
    fireEvent.click(marker);
    expect(props.onTime).toHaveBeenCalledWith(3);
    // A click only seeks: nothing takes focus away from the global shortcuts.
    expect(screen.queryByRole("textbox", { name: "마커 이름" })).not.toBeInTheDocument();
    fireEvent.doubleClick(marker);
    const input = screen.getByRole("textbox", { name: "마커 이름" });
    fireEvent.change(input, { target: { value: "본론" } });
    fireEvent.blur(input);
    expect(props.onCommand).toHaveBeenCalledWith("edit.markerUpdate", { id: "m1", label: "본론", expectedRevision: 7 });
    expect(screen.queryByRole("textbox", { name: "마커 이름" })).not.toBeInTheDocument();
  });

  it("deletes a marker being renamed without sending the rename first", () => {
    const project = fixture();
    project.markers = [{ id: "m1", time: 3, label: "도입" }];
    const { props } = mount({ project });
    fireEvent.doubleClick(screen.getByRole("button", { name: "마커 도입" }));
    fireEvent.change(screen.getByRole("textbox", { name: "마커 이름" }), { target: { value: "본론" } });
    const remove = screen.getByRole("button", { name: "마커 삭제" });
    // The press must not move focus, so the input never blurs into a rename.
    expect(fireEvent.mouseDown(remove)).toBe(false);
    fireEvent.click(remove);
    expect(vi.mocked(props.onCommand).mock.calls).toEqual([["edit.markerDelete", { id: "m1", expectedRevision: 7 }]]);
    expect(screen.queryByRole("textbox", { name: "마커 이름" })).not.toBeInTheDocument();
  });

  it("deletes and reorders tracks, and protects a locked track", () => {
    const project = fixture();
    project.tracks[1].locked = true;
    const { props } = mount({ project });
    expect(screen.getByRole("button", { name: "영상 1 위로 이동" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "영상 2 아래로 이동" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "영상 2 삭제" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "영상 1 아래로 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "영상 2 위로 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "영상 1 삭제" }));
    expect(vi.mocked(props.onCommand).mock.calls).toEqual([
      ["edit.trackMove", { id: "v1", index: 1, expectedRevision: 7 }],
      ["edit.trackMove", { id: "v2", index: 0, expectedRevision: 7 }],
      ["edit.trackDelete", { id: "v1", expectedRevision: 7 }],
    ]);
  });

  it("snaps the dragged clip's end to a marker and its start to the playhead", () => {
    const project = fixture();
    project.clips = [clip("a", 1)];
    project.markers = [{ id: "m1", time: 5.02, label: "마커" }];
    const { props, rerender } = mount({ project, selectedIds: ["a"], selectedId: "a" });
    // +2.0s puts the end at 5.0, within reach of the marker at 5.02.
    fireEvent.pointerDown(item("a"), { clientX: 100 });
    fireEvent.pointerMove(item("a"), { clientX: 236 });
    fireEvent.pointerUp(item("a"));
    const moved = vi.mocked(props.onCommand).mock.calls[0][1] as { commands: { params: { patch: { start: number } } }[] };
    expect(moved.commands[0].params.patch.start).toBeCloseTo(3.02, 10);
    vi.mocked(props.onCommand).mockClear();
    rerender(<Timeline {...props} time={7.03} />);
    fireEvent.pointerDown(item("a"), { clientX: 100 });
    fireEvent.pointerMove(item("a"), { clientX: 100 + 6 * 68 });
    fireEvent.pointerUp(item("a"));
    const next = vi.mocked(props.onCommand).mock.calls[0][1] as typeof moved;
    expect(next.commands[0].params.patch.start).toBe(7.03);
  });

  it("zooms with ⌘/Ctrl + wheel only, and fits the whole project", () => {
    const { container } = mount();
    const workspace = container.querySelector(".timeline-workspace")!;
    const width = () => parseFloat(container.querySelector<HTMLElement>(".timeline-clip")!.style.width);
    expect(width()).toBe(136);
    expect(fireEvent.wheel(workspace, { deltaY: -100 })).toBe(true);
    expect(width()).toBe(136);
    expect(fireEvent.wheel(workspace, { deltaY: -100, ctrlKey: true })).toBe(false);
    expect(width()).toBeGreaterThan(136);
    Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 524 });
    fireEvent.click(screen.getByRole("button", { name: "타임라인 전체 맞춤" }));
    // 500px of track area for a 10s project: 50px per second.
    expect(width()).toBe(100);
  });

  it("draws only the part of the waveform that the clip plays", () => {
    const { container, rerender, props } = mount({ project: audioProject({ sourceIn: 2, duration: 3 }) });
    const bars = () => Array.from(container.querySelectorAll<HTMLElement>(".clip-waveform > i")).map((bar) => bar.style.height);
    expect(bars()).toHaveLength(30);
    expect(bars()[0]).toBe("20%");
    expect(bars()[29]).toBe("49%");
    rerender(<Timeline {...props} project={audioProject({ sourceIn: 2, duration: 3, speed: 2 })} />);
    expect(bars()).toHaveLength(60);
    rerender(<Timeline {...props} project={audioProject({ sourceIn: 2, duration: 3, reverse: true })} />);
    expect(bars()[0]).toBe("49%");
  });

  it("follows the playhead during playback but not while paused", () => {
    const { container, rerender, props } = mount();
    const workspace = container.querySelector<HTMLElement>(".timeline-workspace")!;
    Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 400 });
    rerender(<Timeline {...props} time={9} />);
    expect(workspace.scrollLeft).toBe(0);
    rerender(<Timeline {...props} time={9} playing />);
    expect(workspace.scrollLeft).toBe(9 * 68 - 24);
  });

  it("scrolls when a drag is held at the edge and keeps the clip under the pointer", () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const project = fixture();
    project.clips = [clip("a", 1)];
    const { container, props } = mount({ project, selectedIds: ["a"], selectedId: "a" });
    try {
      const workspace = container.querySelector<HTMLElement>(".timeline-workspace")!;
      vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({ left: 0, right: 500, top: 0, bottom: 300, width: 500, height: 300, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent.pointerDown(item("a"), { clientX: 400 });
      fireEvent.pointerMove(item("a"), { clientX: 498 });
      act(() => frame?.(0));
      expect(workspace.scrollLeft).toBeGreaterThan(0);
      const scrolled = workspace.scrollLeft;
      fireEvent.pointerUp(item("a"));
      const moved = vi.mocked(props.onCommand).mock.calls[0][1] as { commands: { params: { patch: { start: number } } }[] };
      expect(moved.commands[0].params.patch.start).toBeCloseTo(Math.round((1 + (98 + scrolled) / 68) * 30) / 30, 10);
      frame = undefined;
      act(() => raf.mock.calls[raf.mock.calls.length - 1][0](0));
      expect(frame).toBeUndefined();
    } finally {
      raf.mockRestore();
    }
  });

  it("does not scroll, move or trim on a plain click at the edge", () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const project = fixture();
    project.clips = [clip("a", 1)];
    const { container, props } = mount({ project, selectedIds: ["a"], selectedId: "a" });
    try {
      const workspace = container.querySelector<HTMLElement>(".timeline-workspace")!;
      vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({ left: 0, right: 500, top: 0, bottom: 300, width: 500, height: 300, x: 0, y: 0, toJSON: () => ({}) });
      const held = (target: Element) => {
        fireEvent.pointerDown(target, { clientX: 498, clientY: 10 });
        fireEvent.pointerMove(target, { clientX: 500, clientY: 11 });
        act(() => frame?.(0));
        act(() => frame?.(0));
        fireEvent.pointerUp(target);
      };
      held(item("a"));
      held(screen.getByRole("button", { name: "a 시작점 트림" }));
      vi.mocked(props.onTime).mockClear();
      const ruler = container.querySelector(".timeline-ruler")!;
      fireEvent.pointerDown(ruler, { clientX: 498 });
      act(() => frame?.(0));
      fireEvent.pointerUp(ruler);
      expect(workspace.scrollLeft).toBe(0);
      expect(props.onCommand).not.toHaveBeenCalled();
      expect(props.onTime).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
    }
  });

  it("marks clips whose source file is missing", () => {
    const project = fixture();
    project.media[0].missing = true;
    const { container } = mount({ project });
    expect(container.querySelectorAll(".timeline-clip.missing")).toHaveLength(3);
  });
});
