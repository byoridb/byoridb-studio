import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ExportDialog from "./ExportDialog";
import { rpc, savePath } from "./api";
import type { Project } from "./types";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  assetUrl: () => "",
  savePath: vi.fn(),
}));
const native = vi.hoisted(() => ({ value: false }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.value }));
const project = {
  id: "export-test",
  name: "구간 출력",
  revision: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  media: [],
  clips: [
    {
      id: "clip",
      trackId: "video",
      name: "test",
      kind: "image",
      start: 0,
      duration: 12,
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
  background: "#000",
  tracks: [],
  markers: [],
  concept: { audience: "", message: "", appeal: "", direction: "" },
  notes: [],
  updatedAt: 0,
} satisfies Project;
beforeEach(() => {
  vi.clearAllMocks();
  native.value = false;
});
afterEach(() => vi.useRealTimers());

it("exports the selected interval and rejects an inverted interval", async () => {
  vi.mocked(rpc).mockResolvedValue({ id: "render" });
  render(<ExportDialog project={project} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("내보낼 구간"), {
    target: { value: "range" },
  });
  fireEvent.change(screen.getByLabelText("시작 (초)"), {
    target: { value: "4" },
  });
  fireEvent.change(screen.getByLabelText("끝 (초)"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  expect(
    await screen.findByText("내보낼 구간의 시작과 끝을 확인하세요."),
  ).toBeInTheDocument();
  expect(rpc).not.toHaveBeenCalledWith(
    "export.start",
    expect.anything(),
    expect.anything(),
  );
  fireEvent.change(screen.getByLabelText("끝 (초)"), {
    target: { value: "8" },
  });
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "export.start",
      expect.objectContaining({ start: 4, end: 8, format: "mp4" }),
      "export-test",
    ),
  );
});

it("keeps polling until cancellation finishes", async () => {
  vi.mocked(rpc).mockImplementation(async (method) => {
    if (method === "export.start") return { id: "render" };
    if (method === "export.cancel")
      return { id: "render", state: "cancelling" };
    return { id: "render", state: "cancelled", progress: 0.2 };
  });
  render(<ExportDialog project={project} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  fireEvent.click(await screen.findByRole("button", { name: "내보내기 취소" }));
  await screen.findByText("내보내기를 취소하고 있습니다");
  expect(screen.getByRole("button", { name: "내보내기 취소" })).toBeDisabled();
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("export.status", { id: "render" }),
  );
  await act(async () => {});
  expect(await screen.findByRole("button", { name: "내보내기" })).toBeEnabled();
});

const started = () =>
  vi.mocked(rpc).mock.calls.filter(([method]) => method === "export.start");

it("ignores video options for audio formats", async () => {
  vi.mocked(rpc).mockResolvedValue({ id: "render" });
  render(<ExportDialog project={project} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("형식"), { target: { value: "mp3" } });
  for (const label of ["해상도", "프레임레이트", "품질"])
    expect(screen.getByLabelText(label)).toBeDisabled();
  expect(screen.getByLabelText("내보낼 구간")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("형식"), { target: { value: "mov" } });
  expect(screen.getByLabelText("해상도")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("형식"), { target: { value: "mp3" } });
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(started()).toHaveLength(1));
  expect(started()[0][1]).toEqual({
    path: "~/Movies/Byori Studio/구간 출력.mp3",
    format: "mp3",
  });
});

it("never overwrites at a typed path and explains an existing file", async () => {
  vi.mocked(rpc).mockImplementation(async (method) => {
    if (method === "export.start")
      throw new Error("FILE_EXISTS: 같은 경로에 파일이 있습니다");
    return { assetId: "" };
  });
  render(<ExportDialog project={project} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "같은 이름의 파일이 이미 있습니다. 다른 파일 이름을 입력하세요.",
  );
  expect(started()[0][1]).not.toHaveProperty("overwrite");
});

it("overwrites only the exact path confirmed by the native save dialog", async () => {
  native.value = true;
  vi.mocked(savePath).mockResolvedValue("/out/final.mp4");
  vi.mocked(rpc).mockImplementation(async (method) =>
    method === "export.start"
      ? { id: "render" }
      : { id: "render", state: "completed", progress: 1 },
  );
  render(<ExportDialog project={project} onClose={vi.fn()} />);
  fireEvent.click(screen.getByTitle("저장 위치 선택"));
  await waitFor(() =>
    expect(screen.getByLabelText("저장 위치")).toHaveValue("/out/final.mp4"),
  );
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(started()).toHaveLength(1));
  expect(started()[0][1]).toMatchObject({ path: "/out/final.mp4", overwrite: true });
  fireEvent.change(screen.getByLabelText("저장 위치"), {
    target: { value: "/out/other.mp4" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "다시 내보내기" }, { timeout: 3000 }),
  );
  await waitFor(() => expect(started()).toHaveLength(2));
  expect(started()[1][1]).not.toHaveProperty("overwrite");
});

it("closes on Escape only while no export is running", async () => {
  vi.mocked(rpc).mockImplementation(async (method) =>
    method === "export.start"
      ? { id: "render" }
      : { id: "render", state: "running", progress: 0.1 },
  );
  const onClose = vi.fn();
  render(<ExportDialog project={project} onClose={onClose} />);
  expect(screen.getByRole("dialog")).toContainElement(
    document.activeElement as HTMLElement,
  );
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await screen.findByRole("button", { name: "내보내기 취소" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});

it("closes on Escape when idle", () => {
  vi.mocked(rpc).mockResolvedValue({ assetId: "" });
  const onClose = vi.fn();
  render(<ExportDialog project={project} onClose={onClose} />);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("offers the project frame rate so the shown value matches what is exported", async () => {
  vi.mocked(rpc).mockResolvedValue({ id: "render" });
  render(<ExportDialog project={{ ...project, fps: 120 }} onClose={vi.fn()} />);
  const fps = screen.getByLabelText("프레임레이트");
  expect(fps).toHaveValue("120");
  expect(fps).toHaveDisplayValue("120 fps · 프로젝트");
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(started()[0][1]).toMatchObject({ fps: 120 }));
});
