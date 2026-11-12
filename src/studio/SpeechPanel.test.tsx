import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SpeechPanel, { voiceLabel } from "./SpeechPanel";
import { rpc } from "./api";
import type { Project } from "./types";

vi.mock("./api", () => ({ rpc: vi.fn() }));
const project: Project = {
  id: "project1",
  name: "내레이션 편집",
  revision: 2,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  media: [
    {
      id: "media1",
      name: "영상.mp4",
      path: "/tmp/video.mp4",
      kind: "video",
      duration: 10,
      width: 1920,
      height: 1080,
      hasAudio: true,
    },
  ],
  tracks: [
    {
      id: "video1",
      name: "영상",
      kind: "video",
      muted: false,
      hidden: false,
      locked: false,
    },
  ],
  clips: [
    {
      id: "clip1",
      mediaId: "media1",
      trackId: "video1",
      name: "영상.mp4",
      kind: "video",
      start: 0,
      duration: 10,
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
const available = {
  whisperAvailable: true,
  ttsAvailable: true,
  voices: [
    { id: "Samantha", name: "Samantha", language: "en_US" },
    { id: "Yuna", name: "Yuna", language: "ko_KR" },
  ],
};

beforeEach(() => {
  vi.mocked(rpc).mockReset();
});

describe("SpeechPanel", () => {
  it("keeps generation disabled if the actual local engine is unavailable", async () => {
    vi.mocked(rpc).mockResolvedValue({
      whisperAvailable: false,
      ttsAvailable: false,
      voices: [],
    });
    render(
      <SpeechPanel
        mode="transcribe"
        visible
        project={project}
        playhead={0}
        onCommand={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/로컬 Whisper 실행 환경을 찾지 못했습니다/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "자동 자막 생성" }),
    ).toBeDisabled();
  });

  it("submits selected transcription options and refreshes the project only after completion", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "speech.status") return available;
      if (method === "speech.transcribe")
        return { id: "speech1", state: "queued" };
      if (method === "speech.job")
        return {
          id: "speech1",
          state: "completed",
          progress: 1,
          output: "/tmp/captions.srt",
        };
      throw new Error(`Unexpected method ${method}`);
    });
    render(
      <SpeechPanel
        mode="transcribe"
        visible
        project={project}
        playhead={0}
        onCommand={command}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "자동 자막 생성" }),
      ).toBeEnabled(),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "자막 언어" }),
      "en",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "자막 인식 모델" }),
      "small",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "영어로 번역한 자막 생성" }),
    );
    await user.click(screen.getByRole("button", { name: "자동 자막 생성" }));
    expect(rpc).toHaveBeenCalledWith("speech.transcribe", {
      language: "en",
      model: "small",
      translate: true,
    });
    expect(command).not.toHaveBeenCalled();
    await waitFor(() => expect(command).toHaveBeenCalledWith("project.get"), {
      timeout: 2000,
    });
    expect(screen.getByText("타임라인에 추가했습니다")).toBeInTheDocument();
  });

  it("uses a Korean local voice and allows cancelling a synthesis job", async () => {
    const user = userEvent.setup();
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "speech.status") return available;
      if (method === "speech.synthesize")
        return { id: "speech2", state: "running" };
      if (method === "speech.cancel")
        return { id: "speech2", state: "cancelled" };
      if (method === "speech.job")
        return { id: "speech2", state: "running", progress: 0.3 };
      throw new Error(`Unexpected method ${method}`);
    });
    render(
      <SpeechPanel
        mode="synthesize"
        visible
        project={project}
        playhead={2.5}
        onCommand={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "내레이션 목소리" }),
      ).toHaveValue("Yuna"),
    );
    await user.type(
      screen.getByRole("textbox", { name: "음성으로 만들 텍스트" }),
      "오늘의 장면을 기억해요.",
    );
    await user.click(screen.getByRole("button", { name: "음성 생성" }));
    expect(rpc).toHaveBeenCalledWith("speech.synthesize", {
      text: "오늘의 장면을 기억해요.",
      voice: "Yuna",
      rate: 175,
      start: 2.5,
    });
    await user.click(screen.getByRole("button", { name: "음성 작업 중단" }));
    expect(rpc).toHaveBeenCalledWith("speech.cancel", { id: "speech2" });
    expect(await screen.findByText("작업을 중단했습니다")).toBeInTheDocument();
  });

  it("does not retry a failed engine probe in a render loop", async () => {
    vi.mocked(rpc).mockRejectedValue(new Error("음성 엔진 확인 실패"));
    render(
      <SpeechPanel
        mode="transcribe"
        visible
        project={project}
        playhead={0}
        onCommand={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "음성 엔진 확인 실패",
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("says the voices are loading and names them without nested brackets or locale codes", async () => {
    let release = (_value: unknown) => {};
    vi.mocked(rpc).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    render(
      <SpeechPanel mode="synthesize" visible project={project} playhead={0} onCommand={vi.fn()} />,
    );
    const voices = screen.getByRole("combobox", { name: "내레이션 목소리" });
    expect(voices).toHaveTextContent("목소리 불러오는 중…");
    expect(voices).not.toHaveTextContent("사용 가능한 목소리 없음");
    release({
      whisperAvailable: true,
      ttsAvailable: true,
      voices: [{ id: "Eddy", name: "Eddy (한국어(한국))", language: "ko-KR" }],
    });
    await waitFor(() => expect(voices).toHaveTextContent("Eddy · 한국어"));
    expect(voices).not.toHaveTextContent("ko-KR");
    expect(voiceLabel({ name: "Samantha", language: "en_US" })).toBe("Samantha · 영어");
  });
});
