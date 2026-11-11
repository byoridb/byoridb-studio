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
import { pickFiles, savePath, uploadFile } from "./api";
import { PreviewDraftContext } from "./previewDraft";

vi.mock("./api", () => ({
  assetUrl: (id: string) => `http://studio/assets/${id}`,
  pickFiles: vi.fn().mockResolvedValue(null),
  savePath: vi.fn().mockResolvedValue(null),
  uploadFile: vi.fn(),
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
      patch: { filter: "mono" },
    });
    for (const name of ["원본", "시네마", "따뜻한 오후", "쿨 블루", "빈티지"])
      await user.click(screen.getByRole("button", { name }));
    expect(
      command.mock.calls.map(([, params]) => params.patch.filter),
    ).toEqual(["mono", "none", "cinematic", "warm", "cool", "vintage"]);
    expect(
      command.mock.calls.every(([, params]) => !("color" in params.patch)),
    ).toBe(true);
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

describe("Library media management", () => {
  const library = (value: Project, command = vi.fn().mockResolvedValue(value)) => {
    render(
      <Library
        project={value}
        selected={null}
        onCommand={command}
        onImport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    return command;
  };

  it("explains why media used on the timeline cannot be removed", async () => {
    const command = library(project);
    fireEvent.click(screen.getByRole("button", { name: "바다.mp4 소재 삭제" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "타임라인에서 사용 중입니다",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("removes unused media with a revision guard", async () => {
    const command = library({ ...project, clips: [] });
    fireEvent.click(screen.getByRole("button", { name: "바다.mp4 소재 삭제" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("media.remove", {
        id: "media1",
        expectedRevision: 7,
      }),
    );
  });

  it("marks missing media and relinks it to a chosen file", async () => {
    vi.mocked(pickFiles).mockResolvedValueOnce(["/new/ocean.mp4"]);
    const command = library({
      ...project,
      media: [{ ...project.media[0], missing: true }],
    });
    expect(screen.getByText("원본 없음")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "바다.mp4 타임라인에 추가" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "바다.mp4 원본 다시 연결" }),
    );
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("media.relink", {
        id: "media1",
        path: "/new/ocean.mp4",
        expectedRevision: 7,
      }),
    );
  });

  it("shows the thumbnail again once media with a failed thumbnail is relinked", () => {
    const props = {
      selected: null,
      onCommand: vi.fn(),
      onImport: vi.fn(),
      onSelect: vi.fn(),
    };
    const { container, rerender } = render(<Library project={project} {...props} />);
    const thumb = () => container.querySelector(".media-thumb img");
    fireEvent.error(thumb()!);
    expect(thumb()).toBeNull();
    rerender(
      <Library
        project={{
          ...project,
          media: [{ ...project.media[0], path: "/new/ocean.mp4" }],
        }}
        {...props}
      />,
    );
    expect(thumb()).not.toBeNull();
  });

  it("searches built-in presets on every preset tab", async () => {
    library(project);
    const search = () => screen.getByRole("textbox", { name: "소재 검색" });
    fireEvent.click(screen.getByRole("button", { name: "텍스트" }));
    fireEvent.change(search(), { target: { value: "타이틀" } });
    expect(screen.getByRole("button", { name: /타이틀/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /미니멀/ })).toBeNull();
    for (const [tab, hit, miss] of [
      ["스티커", "별", "하트"],
      ["효과", "가까이", "원형 프레임"],
      ["전환", "디졸브", "줌"],
      ["필터", "빈티지", "모노"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      fireEvent.change(search(), { target: { value: hit } });
      expect(screen.getByRole("button", { name: new RegExp(hit) })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: new RegExp(`^${miss}`) })).toBeNull();
    }
    fireEvent.change(search(), { target: { value: "없는 필터" } });
    expect(
      screen.getByText("기본 소재에 검색 결과가 없습니다."),
    ).toBeInTheDocument();
  });

  it("overwrites a caption file only at the path the save dialog confirmed", async () => {
    vi.mocked(savePath).mockResolvedValueOnce("/out/captions.srt");
    const text: Clip = { ...clip, id: "text1", kind: "text", mediaId: undefined };
    const command = library({ ...project, clips: [text] });
    fireEvent.click(screen.getByRole("button", { name: "자막" }));
    fireEvent.click(screen.getByRole("button", { name: "자막 파일 내보내기" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("captions.export", {
        path: "/out/captions.srt",
        overwrite: true,
      }),
    );
  });
});

describe("Inspector color inputs", () => {
  it("previews while choosing and commits a color once when the choice is final", async () => {
    const command = vi.fn().mockResolvedValue(project);
    const text: Clip = {
      ...clip,
      kind: "text",
      mediaId: undefined,
      text: {
        content: "제목",
        fontSize: 64,
        color: "#ffffff",
        fontFamily: "Arial",
        bold: false,
        align: "center",
        background: "#18191de6",
      },
    };
    render(
      <Inspector project={project} selected={text} onCommand={command} playhead={1} />,
    );
    const color = screen.getByLabelText("텍스트 색상");
    for (const value of ["#ff0000", "#00ff00", "#0000ff"])
      fireEvent.input(color, { target: { value } });
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(color, { target: { value: "#0000ff" } });
    fireEvent.blur(color);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith("edit.update", {
      id: "clip1",
      expectedRevision: 7,
      patch: { text: { ...text.text, color: "#0000ff" } },
    });
    command.mockClear();
    const background = screen.getByLabelText("텍스트 배경 색상");
    fireEvent.change(background, { target: { value: "#102030" } });
    expect(command).toHaveBeenCalledWith(
      "edit.update",
      expect.objectContaining({
        patch: { text: { ...text.text, background: "#102030e6" } },
      }),
    );
  });

  it("does not commit when a stored uppercase or 8-digit color is only focused and blurred", () => {
    const command = vi.fn().mockResolvedValue(project);
    const text: Clip = {
      ...clip,
      kind: "text",
      mediaId: undefined,
      text: {
        content: "제목",
        fontSize: 64,
        color: "#FFE76A80",
        fontFamily: "Arial",
        bold: false,
        align: "center",
        background: "#18191DE6",
      },
    };
    const { unmount } = render(
      <Inspector project={project} selected={text} onCommand={command} playhead={1} />,
    );
    const color = screen.getByLabelText("텍스트 색상");
    expect(color).toHaveValue("#ffe76a");
    fireEvent.blur(color);
    fireEvent.blur(screen.getByLabelText("텍스트 배경 색상"));
    expect(command).not.toHaveBeenCalled();
    // Choosing a color keeps the stored alpha.
    fireEvent.change(color, { target: { value: "#0000ff" } });
    expect(command).toHaveBeenCalledWith(
      "edit.update",
      expect.objectContaining({
        patch: { text: { ...text.text, color: "#0000ff80" } },
      }),
    );
    unmount();
    command.mockClear();
    render(
      <Inspector
        project={{ ...project, background: "#FFFFFF" }}
        selected={null}
        onCommand={command}
        playhead={0}
      />,
    );
    fireEvent.blur(screen.getByLabelText("프로젝트 배경 색상"));
    expect(command).not.toHaveBeenCalled();
  });

  it("shows the stored color again and allows a retry after a rejected commit", async () => {
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale revision"))
      .mockResolvedValue(project);
    render(
      <Inspector project={project} selected={null} onCommand={command} playhead={0} />,
    );
    const color = screen.getByLabelText("프로젝트 배경 색상");
    const stored = (color as HTMLInputElement).value;
    fireEvent.input(color, { target: { value: "#223344" } });
    fireEvent.change(color, { target: { value: "#223344" } });
    expect(await screen.findByText("stale revision")).toBeInTheDocument();
    await waitFor(() => expect(color).toHaveValue(stored));
    fireEvent.blur(color);
    expect(command).toHaveBeenCalledTimes(1);
    fireEvent.input(color, { target: { value: "#223344" } });
    fireEvent.change(color, { target: { value: "#223344" } });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("commits the project background once", () => {
    const command = vi.fn().mockResolvedValue(project);
    render(
      <Inspector project={project} selected={null} onCommand={command} playhead={0} />,
    );
    const color = screen.getByLabelText("프로젝트 배경 색상");
    fireEvent.input(color, { target: { value: "#112233" } });
    fireEvent.input(color, { target: { value: "#223344" } });
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(color, { target: { value: "#223344" } });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith("project.update", {
      patch: { background: "#223344" },
    });
  });
});

describe("Library transitions and stickers", () => {
  const next: Clip = { ...clip, id: "clip2", name: "산.mp4", start: 5, duration: 4 };
  const two: Project = { ...project, clips: [clip, next] };
  const open = (
    value: Project,
    selected: Clip | null,
    command = vi.fn().mockResolvedValue(value),
    preview = vi.fn(),
    onSelect = vi.fn(),
  ) => {
    render(
      <PreviewDraftContext.Provider value={preview}>
        <Library
          project={value}
          selected={selected}
          onCommand={command}
          onImport={vi.fn()}
          onSelect={onSelect}
          playhead={2}
        />
      </PreviewDraftContext.Provider>,
    );
    return { command, preview, onSelect };
  };

  it("previews a transition on hover and applies it with a synced fade", async () => {
    const { command, preview } = open(project, clip);
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    const wipe = screen.getByRole("button", { name: "왼쪽 와이프" });
    fireEvent.mouseEnter(wipe);
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      transitionIn: { type: "wipeLeft", duration: 0.5 },
      fadeIn: 0.5,
    });
    fireEvent.mouseLeave(wipe);
    expect(preview).toHaveBeenLastCalledWith("clip1", null);
    fireEvent.click(screen.getByRole("button", { name: "퇴장" }));
    fireEvent.change(screen.getByLabelText("전환 길이"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "줌" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.update", {
        id: "clip1",
        expectedRevision: 7,
        patch: { transitionOut: { type: "zoom", duration: 1.5 }, fadeOut: 1.5 },
      }),
    );
  });

  it("changes the length of an applied transition and removes it", async () => {
    const faded: Clip = {
      ...clip,
      fadeIn: 0.5,
      transitionIn: { type: "slideLeft", duration: 0.5 },
    };
    const { command } = open({ ...project, clips: [faded] }, faded);
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expect(screen.getByRole("button", { name: "왼쪽 슬라이드" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const length = screen.getByLabelText("전환 길이");
    fireEvent.change(length, { target: { value: "1" } });
    fireEvent.blur(length);
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        "edit.update",
        expect.objectContaining({
          patch: { transitionIn: { type: "slideLeft", duration: 1 }, fadeIn: 1 },
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "등장 전환 제거" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        "edit.update",
        expect.objectContaining({ patch: { transitionIn: null, fadeIn: 0 } }),
      ),
    );
  });

  it("offers only a fade for audio clips", () => {
    const audio: Clip = { ...clip, kind: "audio" };
    open({ ...project, clips: [audio] }, audio);
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expect(screen.getByRole("button", { name: "페이드" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "디졸브" })).toBeNull();
  });

  it("joins a clip to the previous one as one atomic batch", async () => {
    const third: Clip = { ...clip, id: "clip3", start: 9, duration: 2 };
    const value = { ...two, clips: [clip, next, third] };
    const { command } = open(value, next);
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    fireEvent.click(screen.getByRole("button", { name: "앞 클립과 겹쳐 전환" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.batch", {
        expectedRevision: 7,
        commands: [
          {
            method: "edit.update",
            params: {
              id: "clip2",
              patch: {
                transitionIn: { type: "dissolve", duration: 0.5 },
                fadeIn: 0.5,
                start: 4.5,
              },
            },
          },
          { method: "edit.update", params: { id: "clip3", patch: { start: 8.5 } } },
        ],
      }),
    );
  });

  it("joins an audio clip with a fade, the only transition audio supports", async () => {
    const first: Clip = { ...clip, kind: "audio" };
    const second: Clip = { ...next, kind: "audio" };
    const { command } = open({ ...project, clips: [first, second] }, second);
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    fireEvent.click(screen.getByRole("button", { name: "앞 클립과 겹쳐 전환" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.batch", {
        expectedRevision: 7,
        commands: [
          {
            method: "edit.update",
            params: {
              id: "clip2",
              patch: {
                transitionIn: { type: "fade", duration: 0.5 },
                fadeIn: 0.5,
                start: 4.5,
              },
            },
          },
        ],
      }),
    );
  });

  it("moves the following clips when a joined clip's transition length changes", async () => {
    const joined: Clip = {
      ...next,
      start: 4.5,
      fadeIn: 0.5,
      transitionIn: { type: "dissolve", duration: 0.5 },
    };
    const third: Clip = { ...clip, id: "clip3", start: 8.5, duration: 2 };
    const { command } = open({ ...project, clips: [clip, joined, third] }, joined);
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    const length = screen.getByLabelText("전환 길이");
    fireEvent.change(length, { target: { value: "1" } });
    fireEvent.blur(length);
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.batch", {
        expectedRevision: 7,
        commands: [
          {
            method: "edit.update",
            params: {
              id: "clip2",
              patch: {
                transitionIn: { type: "dissolve", duration: 1 },
                fadeIn: 1,
                start: 4,
              },
            },
          },
          { method: "edit.update", params: { id: "clip3", patch: { start: 8 } } },
        ],
      }),
    );
  });

  it("imports a sticker as image media, places it at the playhead and scales it down", async () => {
    const media = {
      id: "sticker-media",
      name: "abc-sticker-star.png",
      path: "/imports/abc-sticker-star.png",
      kind: "image" as const,
      duration: 5,
      width: 512,
      height: 512,
      hasAudio: false,
    };
    const uploaded: Project = { ...project, revision: 8, media: [...project.media, media] };
    const placed: Clip = { ...clip, id: "sticker-clip", mediaId: media.id, kind: "image" };
    const added: Project = { ...uploaded, revision: 9, clips: [clip, placed] };
    vi.mocked(uploadFile).mockResolvedValue(uploaded);
    const fetched = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["png"], { type: "image/png" }),
    });
    vi.stubGlobal("fetch", fetched);
    try {
      const { command, onSelect } = open(project, null, vi.fn().mockResolvedValue(added));
      fireEvent.click(screen.getByRole("button", { name: "스티커" }));
      fireEvent.click(screen.getByRole("button", { name: "별 스티커 추가" }));
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith("sticker-clip"));
      expect(fetched.mock.calls[0][0]).toMatch(/stickers\/sticker-star\.png$/);
      const [file, projectId] = vi.mocked(uploadFile).mock.calls[0];
      expect(file.name).toBe("sticker-star.png");
      expect(projectId).toBe("project1");
      // One command, so one undo step.
      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith("edit.add", {
        mediaId: "sticker-media",
        start: 2,
        duration: 3,
        name: "별 스티커",
        transform: { scale: 0.35 },
        expectedRevision: 8,
      });
      expect(onSelect).toHaveBeenCalledWith("sticker-clip");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses a sticker already in the project and reports a failed download", async () => {
    vi.mocked(uploadFile).mockClear();
    const media = { ...project.media[0], id: "m2", name: "x-sticker-heart.png", kind: "image" as const };
    const value = { ...project, media: [...project.media, media] };
    const fetched = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["<html>"], { type: "text/html" }),
    });
    vi.stubGlobal("fetch", fetched);
    try {
      const { command } = open(value, null);
      fireEvent.click(screen.getByRole("button", { name: "스티커" }));
      fireEvent.click(screen.getByRole("button", { name: "하트 스티커 추가" }));
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith(
          "edit.add",
          expect.objectContaining({ mediaId: "m2", expectedRevision: 7 }),
        ),
      );
      expect(fetched).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "별 스티커 추가" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "스티커 이미지를 불러오지 못했습니다.",
      );
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Inspector animation, transitions and styles", () => {
  const inspect = (selected: Clip, value: Project = { ...project, clips: [selected] }, playhead = 2) => {
    const command = vi.fn().mockResolvedValue(value);
    const preview = vi.fn();
    render(
      <PreviewDraftContext.Provider value={preview}>
        <Inspector project={value} selected={selected} onCommand={command} playhead={playhead} />
      </PreviewDraftContext.Provider>,
    );
    return { command, preview };
  };
  const patched = (command: ReturnType<typeof vi.fn>) =>
    (command.mock.calls.slice(-1)[0][1] as { patch: Record<string, unknown> }).patch;
  const text: Clip = {
    ...clip,
    kind: "text",
    mediaId: undefined,
    text: {
      content: "제목",
      fontSize: 64,
      color: "#ffffff",
      fontFamily: "Arial",
      bold: false,
      align: "center",
      background: "transparent",
    },
  };

  it("records the animated value at the playhead and removes that keyframe again", async () => {
    const animated: Clip = {
      ...clip,
      keyframes: [
        { property: "transform.scale", time: 0, value: 1, easing: "easeIn" },
        { property: "transform.scale", time: 2, value: 2 },
      ],
    };
    const { command } = inspect(animated);
    fireEvent.click(screen.getByRole("button", { name: "애니메이션" }));
    // Playhead 2 is clip-local 1: half way through an ease-in from 1 to 2.
    fireEvent.click(screen.getByRole("button", { name: "크기 키프레임 추가" }));
    await waitFor(() => expect(command).toHaveBeenCalled());
    expect(patched(command).keyframes).toEqual([
      { property: "transform.scale", time: 0, value: 1, easing: "easeIn" },
      { property: "transform.scale", time: 1, value: 1.25 },
      { property: "transform.scale", time: 2, value: 2 },
    ]);
    expect(command.mock.calls[0][1]).toMatchObject({ id: "clip1", expectedRevision: 7 });
  });

  it("moves, retimes, eases and deletes a keyframe", async () => {
    const animated: Clip = {
      ...clip,
      keyframes: [
        { property: "transform.x", time: 0, value: 0 },
        { property: "transform.x", time: 3, value: 100 },
      ],
    };
    const { command } = inspect(animated, undefined, 1);
    fireEvent.click(screen.getByRole("button", { name: "애니메이션" }));
    expect(screen.getByRole("button", { name: "위치 X 키프레임 삭제" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(screen.getByLabelText("위치 X 키프레임 1 가속"), {
      target: { value: "easeInOut" },
    });
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(patched(command).keyframes).toEqual([
      { property: "transform.x", time: 0, value: 0, easing: "easeInOut" },
      { property: "transform.x", time: 3, value: 100 },
    ]);
    expect(screen.getByLabelText("위치 X 키프레임 2 가속")).toBeDisabled();
    const time = screen.getByLabelText("위치 X 키프레임 2 시간");
    fireEvent.change(time, { target: { value: "9" } });
    fireEvent.blur(time);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    // Bounded by the clip length.
    expect(patched(command).keyframes).toEqual([
      { property: "transform.x", time: 0, value: 0 },
      { property: "transform.x", time: 4, value: 100 },
    ]);
    const value = screen.getByLabelText("위치 X 키프레임 2 값");
    fireEvent.change(value, { target: { value: "250" } });
    fireEvent.blur(value);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(patched(command).keyframes).toContainEqual({
      property: "transform.x",
      time: 3,
      value: 250,
    });
    fireEvent.click(screen.getByRole("button", { name: "위치 X 키프레임 2 삭제" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4));
    expect(patched(command).keyframes).toEqual([{ property: "transform.x", time: 0, value: 0 }]);
  });

  it("keyframes volume for clips with sound and nothing visual for audio clips", () => {
    const audio: Clip = { ...clip, kind: "audio" };
    inspect(audio);
    fireEvent.click(screen.getByRole("button", { name: "애니메이션" }));
    expect(screen.getByRole("button", { name: "볼륨 키프레임 추가" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "크기 키프레임 추가" })).toBeNull();
    expect(screen.queryByText("인 · 아웃 애니메이션")).toBeNull();
  });

  it("applies an in animation preset as editable keyframes and removes it", async () => {
    const { command } = inspect(clip);
    fireEvent.click(screen.getByRole("button", { name: "애니메이션" }));
    fireEvent.click(screen.getByRole("button", { name: "인 애니메이션 확대" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(patched(command).keyframes).toEqual([
      { property: "transform.scale", time: 0, value: 0.6, easing: "easeOut" },
      { property: "transform.opacity", time: 0, value: 0, easing: "easeOut" },
      { property: "transform.scale", time: 0.5, value: 1 },
      { property: "transform.opacity", time: 0.5, value: 1 },
    ]);
  });

  it("shows the active preset and clears only that edge", async () => {
    const animated: Clip = {
      ...clip,
      keyframes: [
        { property: "transform.x", time: 3.5, value: 0, easing: "easeIn" },
        { property: "transform.x", time: 4, value: 1920 },
        { property: "transform.opacity", time: 0, value: 0, easing: "easeOut" },
        { property: "transform.opacity", time: 0.5, value: 1 },
      ],
    };
    const { command } = inspect(animated);
    fireEvent.click(screen.getByRole("button", { name: "애니메이션" }));
    expect(screen.getByRole("button", { name: "인 애니메이션 페이드" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "아웃" }));
    expect(screen.getByRole("button", { name: "아웃 애니메이션 오른쪽" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "아웃 애니메이션 없음" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(patched(command).keyframes).toEqual(animated.keyframes.slice(2));
  });

  it("sets a transition per edge and treats a legacy fade length as a fade", async () => {
    const legacy: Clip = { ...clip, fadeOut: 0.8 };
    const { command, preview } = inspect(legacy);
    expect(screen.getByLabelText("퇴장 전환")).toHaveValue("fade");
    expect(screen.getByLabelText("등장 전환")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("등장 전환"), { target: { value: "wipeUp" } });
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.update", {
        id: "clip1",
        expectedRevision: 7,
        patch: { transitionIn: { type: "wipeUp", duration: 0.5 }, fadeIn: 0.5 },
      }),
    );
    const length = screen.getByRole("spinbutton", { name: "퇴장 길이" });
    fireEvent.change(length, { target: { value: "1.2" } });
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      transitionOut: { type: "fade", duration: 1.2 },
      fadeOut: 1.2,
    });
    fireEvent.blur(length);
    await waitFor(() =>
      expect(command).toHaveBeenLastCalledWith(
        "edit.update",
        expect.objectContaining({
          patch: { transitionOut: { type: "fade", duration: 1.2 }, fadeOut: 1.2 },
        }),
      ),
    );
  });

  it("separates an overlapped clip when its in transition is removed", async () => {
    const previous: Clip = { ...clip, id: "clip0", start: 0, duration: 3 };
    const joined: Clip = {
      ...clip,
      start: 2.5,
      fadeIn: 0.5,
      transitionIn: { type: "dissolve", duration: 0.5 },
    };
    const later: Clip = { ...clip, id: "clip9", start: 6.5 };
    const { command } = inspect(joined, { ...project, clips: [previous, joined, later] });
    expect(screen.queryByRole("button", { name: "앞 클립과 겹쳐 전환" })).toBeNull();
    fireEvent.change(screen.getByLabelText("등장 전환"), { target: { value: "" } });
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.batch", {
        expectedRevision: 7,
        commands: [
          {
            method: "edit.update",
            params: { id: "clip1", patch: { transitionIn: null, fadeIn: 0, start: 3 } },
          },
          { method: "edit.update", params: { id: "clip9", patch: { start: 7 } } },
        ],
      }),
    );
  });

  it("keeps the overlap equal to a joined clip's in transition and resets both edges", async () => {
    const previous: Clip = { ...clip, id: "clip0", start: 0, duration: 3 };
    const joined: Clip = {
      ...clip,
      start: 2.5,
      fadeIn: 0.5,
      transitionIn: { type: "dissolve", duration: 0.5 },
      fadeOut: 0.4,
      transitionOut: { type: "fade", duration: 0.4 },
    };
    const later: Clip = { ...clip, id: "clip9", start: 6.5 };
    const { command } = inspect(joined, { ...project, clips: [previous, joined, later] });
    const length = screen.getByRole("spinbutton", { name: "등장 길이" });
    fireEvent.change(length, { target: { value: "1" } });
    fireEvent.blur(length);
    await waitFor(() =>
      expect(command).toHaveBeenLastCalledWith("edit.batch", {
        expectedRevision: 7,
        commands: [
          {
            method: "edit.update",
            params: {
              id: "clip1",
              patch: { transitionIn: { type: "dissolve", duration: 1 }, fadeIn: 1, start: 2 },
            },
          },
          { method: "edit.update", params: { id: "clip9", patch: { start: 6 } } },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "전환 초기화" }));
    await waitFor(() =>
      expect(command).toHaveBeenLastCalledWith("edit.batch", {
        expectedRevision: 7,
        commands: [
          {
            method: "edit.update",
            params: {
              id: "clip1",
              patch: {
                transitionIn: null,
                fadeIn: 0,
                transitionOut: null,
                fadeOut: 0,
                start: 3,
              },
            },
          },
          { method: "edit.update", params: { id: "clip9", patch: { start: 7 } } },
        ],
      }),
    );
  });

  it("sets the blend mode", async () => {
    const { command } = inspect(clip);
    fireEvent.change(screen.getByLabelText("블렌드 모드"), { target: { value: "screen" } });
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("edit.update", {
        id: "clip1",
        expectedRevision: 7,
        patch: { blendMode: "screen" },
      }),
    );
  });

  it("previews and commits text outline, shadow, spacing and italics", async () => {
    const { command, preview } = inspect(text);
    fireEvent.click(screen.getByRole("button", { name: "기울임" }));
    await waitFor(() => expect(patched(command).text).toMatchObject({ italic: true }));
    fireEvent.click(screen.getByRole("button", { name: "텍스트 스타일" }));
    const width = screen.getByRole("spinbutton", { name: "외곽선 두께" });
    fireEvent.change(width, { target: { value: "6" } });
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      text: { ...text.text, outline: { color: "#000000", width: 6 } },
    });
    expect(command).toHaveBeenCalledTimes(1);
    fireEvent.blur(width);
    await waitFor(() =>
      expect(patched(command).text).toMatchObject({ outline: { color: "#000000", width: 6 } }),
    );
    const spacing = screen.getByRole("spinbutton", { name: "자간" });
    fireEvent.change(spacing, { target: { value: "80" } });
    fireEvent.blur(spacing);
    await waitFor(() => expect(patched(command).text).toMatchObject({ letterSpacing: 50 }));
    fireEvent.click(screen.getByRole("checkbox", { name: "그림자" }));
    await waitFor(() =>
      expect(patched(command).text).toMatchObject({
        shadow: { color: "#000000", x: 0, y: 4, blur: 8 },
      }),
    );
  });

  it("previews crop, mask, HSL and EQ sliders before committing", async () => {
    const masked: Clip = {
      ...clip,
      mask: { type: "circle", x: 0.5, y: 0.5, width: 1, height: 1, feather: 0 },
    };
    const { command, preview } = inspect(masked);
    fireEvent.click(screen.getByRole("button", { name: "자르기" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "크롭 너비" }), {
      target: { value: "50" },
    });
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
    });
    fireEvent.click(screen.getByRole("button", { name: "마스크" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "가장자리 부드럽게" }), {
      target: { value: "40" },
    });
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      mask: { ...masked.mask, feather: 0.4 },
    });
    fireEvent.click(screen.getByRole("button", { name: "이퀄라이저" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "저음" }), {
      target: { value: "6" },
    });
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      audio: {
        normalize: false,
        denoise: false,
        voiceEnhance: false,
        eq: { bass: 6, mid: 0, treble: 0 },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "조정" }));
    fireEvent.click(screen.getByRole("button", { name: "HSL" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "HSL 채도" }), {
      target: { value: "30" },
    });
    expect(preview).toHaveBeenLastCalledWith("clip1", {
      color: { ...clip.color, hsl: { red: { hue: 0, saturation: 0.3, lightness: 0 } } },
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("resets brightness and colour groups independently", async () => {
    const graded: Clip = {
      ...clip,
      color: { brightness: 0.2, contrast: 1.3, saturation: 0.5, temperature: 0.4, hue: 20 },
    };
    const { command } = inspect(graded);
    fireEvent.click(screen.getByRole("button", { name: "조정" }));
    fireEvent.click(screen.getByRole("button", { name: "색상 초기화" }));
    await waitFor(() =>
      expect(patched(command)).toEqual({
        color: { brightness: 0.2, contrast: 1.3, saturation: 1, temperature: 0, hue: 0 },
        filter: "none",
      }),
    );
  });
});
