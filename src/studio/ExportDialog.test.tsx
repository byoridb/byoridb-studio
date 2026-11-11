import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ExportDialog from "./ExportDialog";
import { rpc } from "./api";
import type { Project } from "./types";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  assetUrl: () => "",
  savePath: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
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
beforeEach(() => vi.clearAllMocks());
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
