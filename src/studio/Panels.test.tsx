import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Library } from "./Library";
import { Inspector } from "./Inspector";
import type { Clip, Project } from "./types";

vi.mock("./api", () => ({
  assetUrl: (id: string) => `http://studio/assets/${id}`,
  pickFiles: vi.fn().mockResolvedValue(null),
  savePath: vi.fn().mockResolvedValue(null),
  rpc: vi
    .fn()
    .mockResolvedValue({
      whisperAvailable: false,
      ttsAvailable: false,
      voices: [],
    }),
}));

const clip: Clip = {
  id: "clip1",
  mediaId: "media1",
  trackId: "video1",
  name: "바다.mp4",
  kind: "video",
  start: 1,
  duration: 4,
  sourceIn: 0,
  speed: 1,
  reverse: false,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
  keyframes: [],
};
const project: Project = {
  id: "project1",
  name: "여행 편집",
  revision: 7,
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  media: [
    {
      id: "media1",
      name: "바다.mp4",
      path: "/tmp/ocean.mp4",
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
  clips: [clip],
  markers: [],
  concept: { audience: "", message: "", appeal: "", direction: "" },
  notes: [],
  updatedAt: "2026-11-01T00:00:00Z",
};

describe("Library", () => {
  it("adds new captions to the selected subtitle layer", async () => {
    const layered: Project = { ...project, tracks: [...project.tracks,
      { id: "text2", name: "자막 2", kind: "text", muted: false, hidden: false, locked: false },
    ] };
    const command = vi.fn().mockResolvedValue(layered);
    render(<Library project={layered} selected={null} targetTrackId="text2" onCommand={command} onImport={vi.fn()} onSelect={vi.fn()} playhead={2} />);
    fireEvent.click(screen.getByRole("button", { name: "텍스트" }));
    fireEvent.click(screen.getByRole("button", { name: "기본 텍스트 추가" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("edit.add", expect.objectContaining({ trackId: "text2", start: 2, duration: 3 })));
  });

  it("does not route MP3 audio into a selected video layer", async () => {
    const audioProject: Project = { ...project, media: [{ ...project.media[0], id: "song", name: "음악.mp3", path: "/tmp/song.mp3", kind: "audio", width: 0, height: 0 }] };
    const command = vi.fn().mockResolvedValue(audioProject);
    render(<Library project={audioProject} selected={null} targetTrackId="video1" onCommand={command} onImport={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "음악.mp3 타임라인에 추가" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("edit.add", { mediaId: "song", start: 0 }));
  });

  it("offers a revision-guarded repair for previously misclassified audio", async () => {
    const stale: Project = { ...project, media: [{ ...project.media[0], name: "음악.mp3", path: "/tmp/song.mp3" }] };
    const command = vi.fn().mockResolvedValue(stale);
    render(<Library project={stale} selected={null} onCommand={command} onImport={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /오디오 분류 다시 확인/ }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("media.reprobe", { ids: ["media1"], expectedRevision: 7 }));
  });

  it("adds media at the playhead and selects the clip returned by the shared command", async () => {
    const user = userEvent.setup();
    const added = { ...clip, id: "clip2", start: 3 };
    const command = vi
      .fn()
      .mockResolvedValue({ ...project, clips: [clip, added] });
    const select = vi.fn();
    render(
      <Library
        project={project}
        selected={clip}
        onCommand={command}
        onImport={vi.fn()}
        onSelect={select}
        playhead={3}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "바다.mp4 타임라인에 추가" }),
    );
    expect(command).toHaveBeenCalledWith("edit.add", {
      mediaId: "media1",
      start: 3,
    });
    await waitFor(() => expect(select).toHaveBeenCalledWith("clip2"));
  });

  it("searches local media without mutating the project", async () => {
    const user = userEvent.setup();
    const command = vi.fn();
    render(
      <Library
        project={project}
        selected={null}
        onCommand={command}
        onImport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "소재 검색" }),
      "없는 소재",
    );
    expect(screen.getByText("검색 결과가 없습니다")).toBeInTheDocument();
    expect(command).not.toHaveBeenCalled();
  });

  it("applies a filter as editable color values guarded by the project revision", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Library
        project={project}
        selected={clip}
        onCommand={command}
        onImport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "필터" }));
    await user.click(screen.getByRole("button", { name: "모노" }));
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        color: { brightness: 0, contrast: 1.12, saturation: 0, temperature: 0 },
        filter: "mono",
      },
    });
  });

  it("creates an audio track before extracting audio from imported video", async () => {
    const user = userEvent.setup();
    const track = {
      id: "audio1",
      name: "오디오",
      kind: "audio",
      muted: false,
      hidden: false,
      locked: false,
    };
    const command = vi
      .fn()
      .mockResolvedValueOnce({ ...project, tracks: [...project.tracks, track] })
      .mockResolvedValueOnce(project);
    render(
      <Library
        project={project}
        selected={null}
        onCommand={command}
        onImport={vi.fn()}
        onSelect={vi.fn()}
        playhead={2}
      />,
    );
    await user.click(
      within(screen.getByRole("navigation", { name: "편집 소재" })).getByRole(
        "button",
        { name: "오디오" },
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "바다.mp4 타임라인에 추가" }),
    );
    expect(command).toHaveBeenNthCalledWith(1, "edit.track", {
      kind: "audio",
      name: "오디오",
    });
    await waitFor(() =>
      expect(command).toHaveBeenNthCalledWith(2, "edit.add", {
        mediaId: "media1",
        trackId: "audio1",
        start: 2,
      }),
    );
  });

  it("surfaces command failures instead of showing a successful edit", async () => {
    const user = userEvent.setup();
    const command = vi
      .fn()
      .mockRejectedValue(new Error("다른 작업이 프로젝트를 수정했습니다."));
    render(
      <Library
        project={project}
        selected={clip}
        onCommand={command}
        onImport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "바다.mp4 타임라인에 추가" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "다른 작업이 프로젝트를 수정했습니다.",
    );
  });
});

describe("Inspector", () => {
  it("commits numeric edits on blur rather than every keystroke", async () => {
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "크기" });
    fireEvent.change(input, { target: { value: "125" } });
    expect(command).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.update", {
        id: "clip1",
        expectedRevision: 7,
        patch: {
          transform: { x: 0, y: 0, scale: 1.25, rotation: 0, opacity: 1 },
        },
      }),
    );
  });

  it("keeps the same source range when playback speed changes", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(screen.getByRole("button", { name: "속도" }));
    await user.click(screen.getByRole("button", { name: "2×" }));
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: { speed: 2, duration: 2 },
    });
  });

  it("writes clip-relative keyframes and replaces a frame at the same time", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    const animated = {
      ...clip,
      keyframes: [{ property: "transform.scale", time: 1, value: 0.8 }],
    };
    render(
      <Inspector
        project={project}
        selected={animated}
        onCommand={command}
        playhead={2}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "크기 키프레임 추가" }),
    );
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        keyframes: [{ property: "transform.scale", time: 1, value: 1 }],
      },
    });
  });

  it("edits the project aspect ratio when no clip is selected", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={null}
        onCommand={command}
        playhead={0}
      />,
    );
    await user.click(screen.getByRole("button", { name: "9:16" }));
    expect(command).toHaveBeenCalledWith("project.update", {
      patch: { width: 1080, height: 1920 },
    });
  });

  it("flips a clip while preserving its existing transform", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    const positioned = {
      ...clip,
      transform: { ...clip.transform, x: 120, scale: 0.8 },
    };
    render(
      <Inspector
        project={project}
        selected={positioned}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(screen.getByRole("button", { name: "좌우 뒤집기" }));
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        transform: {
          x: 120,
          y: 0,
          scale: 0.8,
          rotation: 0,
          opacity: 1,
          flipX: true,
        },
      },
    });
  });

  it("calculates a centered portrait crop from the original media dimensions", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "자르기", expanded: false }),
    );
    await user.click(screen.getByRole("button", { name: "9:16 크롭" }));
    const width = 9 / 16 / (1920 / 1080);
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: { crop: { x: (1 - width) / 2, y: 0, width, height: 1 } },
    });
  });

  it("constrains crop position so its area stays within the source", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={{ ...clip, crop: { x: 0, y: 0, width: 0.5, height: 1 } }}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "자르기", expanded: false }),
    );
    const input = screen.getByRole("spinbutton", { name: "크롭 X" });
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: { crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    });
  });

  it("enables chroma key with explicit usable default parameters", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "크로마키", expanded: false }),
    );
    await user.click(screen.getByRole("checkbox", { name: "크로마키 사용" }));
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        chromaKey: {
          enabled: true,
          color: "#00ff00",
          similarity: 0.1,
          blend: 0.05,
        },
      },
    });
  });

  it("changes EQ without removing other audio processing", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    const processed = {
      ...clip,
      audio: {
        normalize: true,
        denoise: true,
        voiceEnhance: false,
        eq: { bass: 0, mid: 2, treble: 1 },
      },
    };
    render(
      <Inspector
        project={project}
        selected={processed}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "이퀄라이저", expanded: false }),
    );
    const input = screen.getByRole("spinbutton", { name: "저음" });
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        audio: {
          normalize: true,
          denoise: true,
          voiceEnhance: false,
          eq: { bass: 3, mid: 2, treble: 1 },
        },
      },
    });
  });

  it("changes one HSL channel while preserving existing channel corrections", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    const corrected = {
      ...clip,
      color: {
        ...clip.color,
        hsl: {
          red: { hue: 10, saturation: 0.2, lightness: 0 },
          blue: { hue: -5 },
        },
      },
    };
    render(
      <Inspector
        project={project}
        selected={corrected}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(screen.getByRole("button", { name: "조정" }));
    await user.click(
      screen.getByRole("button", { name: "HSL", expanded: false }),
    );
    await user.click(screen.getByRole("button", { name: "파랑" }));
    const input = screen.getByRole("spinbutton", { name: "HSL 밝기" });
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        color: {
          ...clip.color,
          hsl: {
            red: { hue: 10, saturation: 0.2, lightness: 0 },
            blue: { hue: -5, saturation: 0, lightness: 0.2 },
          },
        },
      },
    });
  });

  it("adds and edits a custom curve control point using keyboard controls", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(screen.getByRole("button", { name: "조정" }));
    await user.click(
      screen.getByRole("button", { name: "곡선", expanded: false }),
    );
    await user.click(screen.getByRole("button", { name: "곡선 점 추가" }));
    expect(command).toHaveBeenLastCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        color: {
          ...clip.color,
          curves: {
            preset: "none",
            master: [
              [0, 0],
              [0.5, 0.5],
              [1, 1],
            ],
          },
        },
      },
    });
    const point = screen.getByRole("button", {
      name: "곡선 점 2, 입력 128, 출력 128",
    });
    fireEvent.keyDown(point, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyUp(point, { key: "ArrowUp" });
    expect(command).toHaveBeenLastCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: {
        color: {
          ...clip.color,
          curves: {
            preset: "none",
            master: [
              [0, 0],
              [0.5, 0.55],
              [1, 1],
            ],
          },
        },
      },
    });
  });

  it("imports a real LUT path with the selected clip and project revision", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(screen.getByRole("button", { name: "조정" }));
    await user.click(
      screen.getByRole("button", { name: "LUT", expanded: false }),
    );
    expect(screen.getByRole("button", { name: "LUT 가져오기" })).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "LUT 파일 경로" }),
      "/tmp/film.cube",
    );
    await user.click(screen.getByRole("button", { name: "LUT 가져오기" }));
    expect(command).toHaveBeenCalledWith("color.importLut", {
      id: "clip1",
      path: "/tmp/film.cube",
      expectedRevision: 7,
    });
  });

  it("enables stabilization only for video with a valid initial strength", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue(project);
    const { rerender } = render(
      <Inspector
        project={project}
        selected={clip}
        onCommand={command}
        playhead={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "흔들림 보정", expanded: false }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "흔들림 보정 사용" }),
    );
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: { stabilize: { enabled: true, strength: 1 } },
    });
    rerender(
      <Inspector
        project={project}
        selected={{ ...clip, id: "photo", kind: "image" }}
        onCommand={command}
        playhead={1}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "흔들림 보정" }),
    ).not.toBeInTheDocument();
  });
});
