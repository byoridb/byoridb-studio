import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FontLibrary, PresetLibrary } from "./CustomAssets";
import { Inspector } from "./Inspector";
import { PreviewDraftContext } from "./previewDraft";
import { pickFiles, rpc } from "./api";
import type { Clip, Project } from "./types";

vi.mock("./api", () => ({ rpc: vi.fn(), pickFiles: vi.fn(), savePath: vi.fn(), assetUrl: (id: string) => `/assets/${id}` }));
const visual: Clip = { id: "c1", trackId: "v1", kind: "image", name: "Scene", start: 0, duration: 4, sourceIn: 0, speed: 1, reverse: false, volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, keyframes: [] };
const project: Project = { id: "p1", name: "Test", revision: 3, width: 1920, height: 1080, fps: 30, background: "#000000", media: [], tracks: [{ id: "v1", name: "Video", kind: "video", muted: false, hidden: false, locked: false }], clips: [visual], markers: [], concept: { audience: "", message: "", appeal: "", direction: "" }, notes: [], updatedAt: 0 };
const font = { id: "font-one", name: "내 글꼴", family: "Byori-font-one", path: "/managed/font.ttf" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(rpc).mockResolvedValue({ fonts: [], presets: [] }); });

describe("Reusable assets", () => {
  it("imports a font using the font picker and applies it as one revision-guarded edit", async () => {
    const user = userEvent.setup();
    let fonts: typeof font[] = [];
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "fonts.import") { fonts = [font]; return font; }
      return { fonts, presets: [] };
    });
    vi.mocked(pickFiles).mockResolvedValue(["/source/font.ttf"]);
    const selected = { ...visual, kind: "text" as const, text: { content: "Hello", fontSize: 64, fontFamily: "Arial", bold: false, color: "#ffffff", align: "center", background: "transparent" } };
    const command = vi.fn().mockResolvedValue(project);
    render(<FontLibrary project={project} selected={selected} onCommand={command} />);
    await user.click(screen.getByRole("button", { name: "글꼴 추가" }));
    expect(pickFiles).toHaveBeenCalledWith(["ttf", "otf"]);
    expect(rpc).toHaveBeenCalledWith("fonts.import", { path: "/source/font.ttf" });
    await user.click(await screen.findByRole("button", { name: "내 글꼴 글꼴 적용" }));
    expect(command).toHaveBeenCalledWith("fonts.apply", { id: "font-one", clipId: "c1", expectedRevision: 3 });
  });

  it("saves the selected filter with project binding and reports import errors", async () => {
    const user = userEvent.setup();
    const command = vi.fn();
    render(<PresetLibrary kind="filter" project={project} selected={visual} onCommand={command} />);
    await user.type(screen.getByRole("textbox", { name: "필터 프리셋 이름" }), "Warm brand");
    await user.click(screen.getByRole("button", { name: "현재 필터 저장" }));
    expect(rpc).toHaveBeenCalledWith("presets.save", { clipId: "c1", name: "Warm brand", kind: "filter", expectedRevision: 3 }, "p1");
    vi.mocked(pickFiles).mockResolvedValue(["/tmp/untrusted.json"]);
    vi.mocked(rpc).mockRejectedValueOnce(new Error("지원하지 않는 프리셋 필드입니다."));
    await user.click(screen.getByRole("button", { name: "가져오기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("지원하지 않는 프리셋 필드입니다.");
    expect(command).not.toHaveBeenCalled();
  });

  it("previews a saved filter on hover without writing to the project", async () => {
    const preset = { id: "preset-one", name: "Soft", kind: "filter", target: "visual", sourceDuration: 4, patch: { color: { ...visual.color, contrast: .8 } } };
    vi.mocked(rpc).mockResolvedValue({ fonts: [], presets: [preset] });
    const preview = vi.fn(), command = vi.fn();
    render(<PreviewDraftContext.Provider value={preview}><PresetLibrary kind="filter" project={project} selected={visual} onCommand={command} /></PreviewDraftContext.Provider>);
    const button = await screen.findByRole("button", { name: "Soft" });
    fireEvent.mouseEnter(button);
    expect(preview).toHaveBeenLastCalledWith("c1", preset.patch);
    fireEvent.mouseLeave(button);
    expect(preview).toHaveBeenLastCalledWith("c1", null);
    expect(command).not.toHaveBeenCalled();
  });

  it("shows slider changes immediately and commits only on release", async () => {
    const user = userEvent.setup(), preview = vi.fn(), command = vi.fn().mockResolvedValue(project);
    render(<PreviewDraftContext.Provider value={preview}><Inspector project={project} selected={visual} onCommand={command} playhead={0} /></PreviewDraftContext.Provider>);
    await user.click(screen.getByRole("button", { name: "조정" }));
    const slider = screen.getByRole("slider", { name: "밝기 슬라이더" });
    fireEvent.change(slider, { target: { value: "35" } });
    expect(preview).toHaveBeenLastCalledWith("c1", { color: { ...visual.color, brightness: .35 } });
    expect(command).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command).toHaveBeenCalledWith("edit.update", { id: "c1", patch: { color: { ...visual.color, brightness: .35 } }, expectedRevision: 3 });
  });

  it("selects a system font without resending a managed font path", async () => {
    const user = userEvent.setup(), command = vi.fn().mockResolvedValue(project);
    const selected = { ...visual, kind: "text" as const, text: { content: "Hello", fontSize: 64, fontFamily: font.family, fontId: font.id, fontPath: font.path, bold: false, color: "#ffffff", align: "center", background: "transparent" } };
    vi.mocked(rpc).mockResolvedValue({ fonts: [font], presets: [] });
    render(<Inspector project={project} selected={selected} onCommand={command} playhead={0} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "글꼴" }), "Arial");
    expect(command).toHaveBeenCalledWith("edit.update", { id: "c1", expectedRevision: 3, patch: { text: { fontFamily: "Arial" } } });
  });
});
