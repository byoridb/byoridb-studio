import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Home, { relativeDate } from "./Home";
import { rpc } from "./api";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  projectThumbnailUrl: (id: string, mediaId: string) => `http://service/projects/${id}/thumbnail?media=${mediaId}`,
}));
const list = [
  { id: "old", name: "오래된 편집", updatedAt: "2026-10-01T10:00:00Z" },
  { id: "new", name: "최신 편집", updatedAt: "2026-11-10T10:00:00Z" },
];
const mount = (extra: Partial<React.ComponentProps<typeof Home>> = {}) => {
  const props = { currentId: "new", onCreate: vi.fn(), onOpen: vi.fn(), onExample: vi.fn(), onSettings: vi.fn(), ...extra };
  return { props, ...render(<Home {...props} />) };
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rpc).mockImplementation(async (method: string) => (method === "project.list" ? list : undefined));
});

describe("home screen", () => {
  it("starts a project in each frame preset, opens the example and settings", async () => {
    const { props } = mount();
    await screen.findByText("최신 편집");
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트 16:9 가로" }));
    expect(props.onCreate).toHaveBeenLastCalledWith(1920, 1080);
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트 9:16 세로" }));
    expect(props.onCreate).toHaveBeenLastCalledWith(1080, 1920);
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트 1:1 정사각형" }));
    expect(props.onCreate).toHaveBeenLastCalledWith(1080, 1080);
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트 4:5 피드" }));
    expect(props.onCreate).toHaveBeenLastCalledWith(1080, 1350);
    fireEvent.click(screen.getByRole("button", { name: /예제 열기/ }));
    expect(props.onExample).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "설정" }));
    expect(props.onSettings).toHaveBeenCalledOnce();
  });
  it("lists recent projects newest first and opens one", async () => {
    const { props, container } = mount();
    await screen.findByText("최신 편집");
    const names = Array.from(container.querySelectorAll(".home-grid strong")).map((element) => element.textContent);
    expect(names).toEqual(["최신 편집", "오래된 편집"]);
    expect(container.querySelector(".home-grid li.current")).toHaveTextContent("열려 있음");
    fireEvent.click(screen.getByRole("button", { name: "오래된 편집 열기" }));
    expect(props.onOpen).toHaveBeenCalledWith("old");
  });
  it("renames inline, cancels with Escape, and duplicates", async () => {
    vi.mocked(rpc).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "project.rename") return list.map((item) => (item.id === params?.id ? { ...item, name: String(params.name) } : item));
      if (method === "project.duplicate") return { id: "copy", name: "오래된 편집 사본", updatedAt: 1 };
      return list;
    });
    mount();
    await screen.findByText("오래된 편집");
    fireEvent.click(screen.getByRole("button", { name: "오래된 편집 이름 변경" }));
    let input = screen.getByLabelText("프로젝트 이름");
    fireEvent.change(input, { target: { value: "버릴 이름" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(rpc).not.toHaveBeenCalledWith("project.rename", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "오래된 편집 이름 변경" }));
    input = screen.getByLabelText("프로젝트 이름");
    fireEvent.change(input, { target: { value: "  가을 여행  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("project.rename", { id: "old", name: "가을 여행" }));
    expect(await screen.findByText("가을 여행")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "가을 여행 복제" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("project.duplicate", { id: "old" }));
    // A duplicate answers with one summary, so the list is read again.
    await waitFor(() => expect(vi.mocked(rpc).mock.calls.filter(([method]) => method === "project.list")).toHaveLength(2));
  });
  it("deletes only after confirmation and never the open project", async () => {
    vi.mocked(rpc).mockImplementation(async (method: string) => (method === "project.delete" ? [list[1]] : list));
    mount();
    await screen.findByText("오래된 편집");
    expect(screen.getByRole("button", { name: "최신 편집 삭제" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "오래된 편집 삭제" }));
    expect(rpc).not.toHaveBeenCalledWith("project.delete", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "오래된 편집 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "삭제 확인" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("project.delete", { id: "old" }));
    await waitFor(() => expect(screen.queryByText("오래된 편집")).toBeNull());
  });
  it("shows an empty store and reports a failed store operation", async () => {
    vi.mocked(rpc).mockResolvedValueOnce([]);
    const first = mount();
    expect(await screen.findByText(/저장된 프로젝트가 없습니다/)).toBeInTheDocument();
    // With nothing to list, the way into the example is the empty state's one button.
    expect(first.container.querySelector(".home-count")).toBeNull();
    const examples = screen.getAllByRole("button", { name: "예제 열기" });
    expect(examples).toHaveLength(1);
    expect(examples[0].closest(".home-empty-state")).not.toBeNull();
    fireEvent.click(examples[0]);
    expect(first.props.onExample).toHaveBeenCalledOnce();
    first.unmount();
    vi.mocked(rpc).mockImplementation(async (method: string) => {
      if (method === "project.list") return list;
      throw new Error("프로젝트를 찾을 수 없습니다.");
    });
    mount();
    await screen.findByText("오래된 편집");
    fireEvent.click(screen.getByRole("button", { name: "오래된 편집 복제" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("프로젝트를 찾을 수 없습니다.");
    expect(screen.getByText("오래된 편집")).toBeInTheDocument();
  });
  it("shows a project's first frame when the service has one and the icon otherwise", async () => {
    vi.mocked(rpc).mockResolvedValue([{ ...list[0], thumbnail: { mediaId: "m1", path: "/private/thumb.jpg" } }, list[1]]);
    mount();
    const withCover = await screen.findByRole("button", { name: "오래된 편집 열기" });
    const image = withCover.querySelector("img")!;
    // The service route, never the local file path.
    expect(image).toHaveAttribute("src", "http://service/projects/old/thumbnail?media=m1");
    expect(screen.getByRole("button", { name: "최신 편집 열기" }).querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "최신 편집 열기" }).querySelector("svg")).not.toBeNull();
    // An unreadable thumbnail falls back to the icon.
    fireEvent.error(image);
    expect(withCover.querySelector("img")).toBeNull();
    expect(withCover.querySelector("svg")).not.toBeNull();
  });
  it("leaves the untouched auto-created project out, so a first run shows the empty state", async () => {
    vi.mocked(rpc).mockResolvedValue([list[1]]);
    mount({ hiddenId: "new" });
    expect(await screen.findByText(/저장된 프로젝트가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText("최신 편집")).toBeNull();
  });
  it("leaves out closed projects that are empty and still unnamed, and keeps named empty ones", async () => {
    vi.mocked(rpc).mockResolvedValue([
      { id: "auto", name: "새 프로젝트", updatedAt: 3, empty: true },
      { id: "named", name: "여름 브이로그", updatedAt: 2, empty: true },
      { id: "worked", name: "새 프로젝트", updatedAt: 1 },
    ]);
    mount();
    expect(await screen.findByText("여름 브이로그")).toBeInTheDocument();
    // The section heading and the one project that has work in it.
    expect(screen.getAllByText("새 프로젝트")).toHaveLength(2);
  });
  it("reads the list again when told the stored projects may have changed", async () => {
    const { props, rerender } = mount();
    await screen.findByText("오래된 편집");
    vi.mocked(rpc).mockImplementation(async () => [list[1]]);
    rerender(<Home {...props} reload={1} />);
    await waitFor(() => expect(screen.queryByText("오래된 편집")).toBeNull());
    expect(screen.getByText("최신 편집")).toBeInTheDocument();
  });
  it("writes dates relative to today", () => {
    const now = new Date(2026, 10, 12, 15, 0);
    expect(relativeDate(new Date(2026, 10, 12, 2, 35).getTime(), now)).toBe("오늘 오전 2:35");
    expect(relativeDate(new Date(2026, 10, 11, 21, 10).getTime(), now)).toBe("어제 오후 9:10");
    expect(relativeDate(new Date(2026, 9, 1, 10, 0).getTime(), now)).toBe("10월 1일");
    expect(relativeDate(new Date(2025, 11, 31, 10, 0).getTime(), now)).toBe("2025년 12월 31일");
    expect(relativeDate("not a date", now)).toBe("");
  });
});
