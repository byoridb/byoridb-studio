import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Settings, { resetInstallation } from "./Settings";
import { rpc } from "./api";
import type { RuntimeStatus } from "./types";

vi.mock("./api", () => ({ rpc: vi.fn() }));

const status = (installed: boolean): RuntimeStatus => ({
  ffmpeg: { available: true, version: "ffmpeg 7" },
  providers: [
    { id: "claude", name: "Claude Code", available: true, authStatus: "missing" },
  ],
  byoridb: { installed, running: false, connected: false },
});
const release = {
  installedVersion: "",
  latestVersion: "v1.2.0",
  tag: "v1.2.0",
  url: "https://example.com/release",
  updateAvailable: true,
};
const mcp = { added: false, enabled: false, phase: "unchecked", url: "", toolCount: 0, bridgeAvailable: true };
let installed = false;
let jobState = "running";
const calls = (method: string) =>
  vi.mocked(rpc).mock.calls.filter(([name]) => name === method);

beforeEach(() => {
  vi.clearAllMocks();
  resetInstallation();
  installed = false;
  jobState = "running";
  vi.mocked(rpc).mockImplementation(async (method) => {
    if (method === "runtime.status") return status(installed);
    if (method === "runtime.checkUpdate") return release;
    if (method === "runtime.install")
      return { id: "install1", state: "running", progress: 0, logs: [] };
    if (method === "runtime.installStatus")
      return {
        id: "install1",
        state: jobState,
        progress: 0.4,
        logs: [{ at: "", stream: "info", text: "내려받는 중" }],
      };
    return mcp;
  });
});

describe("Settings", () => {
  it("installs ByoriDB in one step and restores the progress after reopening", async () => {
    const { unmount } = render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /ByoriDB 설치/ }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("runtime.install", { tag: "v1.2.0" }),
    );
    expect(calls("runtime.checkUpdate")).toHaveLength(1);
    expect(await screen.findByText("설치 진행 중")).toBeInTheDocument();
    unmount();

    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText("설치 진행 중")).toBeInTheDocument();
    expect(screen.getByText("내려받는 중")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ByoriDB 설치/ })).toBeDisabled();
    expect(calls("runtime.install")).toHaveLength(1);

    installed = true;
    jobState = "completed";
    expect(
      await screen.findByText("설치 완료", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /ByoriDB 설치/ })).toBeNull(),
    );
  });

  it("does not show a finished installation again", async () => {
    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    await screen.findByRole("button", { name: /ByoriDB 설치/ });
    expect(screen.queryByText("설치 완료")).toBeNull();
    expect(calls("runtime.installStatus")).toHaveLength(0);
  });

  it("moves focus into the dialog, traps Tab and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<Settings onClose={onClose} onUpdate={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Studio 설정" });
    const close = screen.getByTitle("설정 닫기");
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "완료" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("shows which agent needs sign-in", async () => {
    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText("로그인 필요")).toBeInTheDocument();
  });

  it("shows values as being checked while loading, then a short engine name with the path as a tooltip", async () => {
    let release = (_value: unknown) => {};
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "runtime.status") return new Promise((resolve) => { release = resolve; });
      return mcp;
    });
    const { container } = render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(screen.getAllByText("확인 중…").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("확인되지 않음")).toBeNull();
    expect(screen.queryByText("확인 필요")).toBeNull();
    expect(screen.queryByText(/로컬 작업 공간/)).toBeNull();
    expect(screen.queryByText(/연결을 관리합니다/)).toBeNull();
    release({
      ...status(true),
      ffmpeg: {
        available: true,
        path: "/opt/homebrew/bin/ffmpeg",
        version: "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers",
      },
    });
    const engine = await screen.findByText("FFmpeg 7.1.1");
    expect(engine).toHaveAttribute("title", "/opt/homebrew/bin/ffmpeg");
    expect(container).not.toHaveTextContent("Copyright");
    expect(screen.queryByText("확인 중…")).toBeNull();
  });

  it("shows storage per folder and cleans unused temporary files only after confirming", async () => {
    const usage = (reclaimable: number) => ({
      folders: {
        proxies: { files: 2, bytes: 300 * 1024 * 1024, cleanable: true, reclaimableBytes: reclaimable, reclaimableFiles: 1 },
        imports: { files: 4, bytes: 2 * 1024 * 1024 * 1024, cleanable: false },
        speech: { files: 0, bytes: 0, cleanable: false },
        renders: { files: 0, bytes: 0, cleanable: true, reclaimableBytes: 0, reclaimableFiles: 0 },
        previews: { files: 9, bytes: 5 * 1024 * 1024, cleanable: true, reclaimableBytes: 0, reclaimableFiles: 0 },
      },
      bytes: 2353 * 1024 * 1024,
      reclaimableBytes: reclaimable,
    });
    let reclaimable = 120 * 1024 * 1024;
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "runtime.status") return status(true);
      if (method === "storage.usage") return usage(reclaimable);
      if (method === "storage.clean") {
        reclaimable = 0;
        return { ...usage(0), removedBytes: 120 * 1024 * 1024 };
      }
      return mcp;
    });
    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText("가져온 소재")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB")).toBeInTheDocument();
    expect(screen.getByText("300 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /쓰지 않는 임시 파일 정리 \(120 MB\)/ }));
    expect(calls("storage.clean")).toHaveLength(0);
    expect(screen.getByText(/원본\s+소재와 프로젝트는 지우지 않습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(calls("storage.clean")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /쓰지 않는 임시 파일 정리/ }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(await screen.findByText(/120 MB를\s+정리했습니다/)).toBeInTheDocument();
    expect(calls("storage.clean")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /쓰지 않는 임시 파일 정리/ })).toBeDisabled(),
    );
  });

  it("offers to delete empty projects and shows the proxy limit only when the service reports them", async () => {
    const folders = {
      proxies: { files: 2, bytes: 300 * 1024 * 1024, cleanable: true, reclaimableBytes: 0, reclaimableFiles: 0 },
      imports: { files: 4, bytes: 2 * 1024 * 1024 * 1024, cleanable: false },
    };
    let empty = 3;
    let extended = false;
    let limit = 4.5 * 1024 * 1024 * 1024;
    const usage = () => ({
      folders,
      bytes: 2348 * 1024 * 1024,
      reclaimableBytes: 0,
      ...(extended && {
        emptyProjects: { count: empty, bytes: 4096 },
        proxyLimitBytes: limit,
      }),
    });
    vi.mocked(rpc).mockImplementation(async (method, params) => {
      if (method === "runtime.status") return status(true);
      if (method === "storage.usage") return usage();
      if (method === "storage.configure") {
        limit = (params as { proxyLimitBytes: number }).proxyLimitBytes;
        return usage();
      }
      if (method === "storage.clean") {
        const removed = empty;
        empty = 0;
        return { folders, bytes: 0, emptyProjects: { count: 0, bytes: 0, removed } };
      }
      return mcp;
    });
    // A service that reports neither: nothing about projects or a limit is shown.
    const older = render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText("재생용 프록시")).toBeInTheDocument();
    expect(screen.getByText("300 MB")).toBeInTheDocument();
    expect(screen.queryByText("빈 프로젝트")).toBeNull();
    expect(screen.queryByText(/한도/)).toBeNull();
    expect(screen.queryByRole("button", { name: /빈 프로젝트/ })).toBeNull();
    older.unmount();

    extended = true;
    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText("빈 프로젝트")).toBeInTheDocument();
    expect(screen.getByText("3개")).toBeInTheDocument();
    // The limit in force is offered even when it is not one of the usual choices.
    const limitField = screen.getByRole("combobox", { name: "프록시 한도" });
    expect(limitField).toHaveDisplayValue("4.5 GB");
    expect(Array.from(limitField.querySelectorAll("option"), (option) => option.textContent)).toEqual([
      "4.5 GB",
      "5 GB",
      "10 GB",
      "20 GB",
      "50 GB",
      "제한 없음",
    ]);
    fireEvent.change(limitField, { target: { value: "0" } });
    await waitFor(() => expect(limitField).toHaveDisplayValue("제한 없음"));
    expect(calls("storage.configure")).toEqual([["storage.configure", { proxyLimitBytes: 0 }]]);
    fireEvent.change(limitField, { target: { value: String(10 * 1024 ** 3) } });
    await waitFor(() => expect(limitField).toHaveDisplayValue("10 GB"));
    expect(calls("storage.configure")[1]).toEqual(["storage.configure", { proxyLimitBytes: 10 * 1024 ** 3 }]);
    // The choice that was only there because it was in force is gone.
    expect(limitField.querySelectorAll("option")).toHaveLength(5);
    // Nothing temporary to clean, yet the empty projects can still be removed.
    expect(screen.getByRole("button", { name: /쓰지 않는 임시 파일 정리/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "빈 프로젝트 3개 삭제" }));
    expect(calls("storage.clean")).toHaveLength(0);
    expect(screen.getByText(/프로젝트\s+3개를 삭제합니다\. 되돌릴 수 없습니다\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(calls("storage.clean")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "빈 프로젝트 3개 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(await screen.findByText("빈 프로젝트 3개를 삭제했습니다")).toBeInTheDocument();
    expect(calls("storage.clean")).toEqual([["storage.clean", { targets: ["emptyProjects"] }]]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /빈 프로젝트/ })).toBeNull());
  });

  it("leaves the storage section out when the service does not report it", async () => {
    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    await screen.findByText("로그인 필요");
    expect(screen.queryByText("저장 공간")).toBeNull();
  });

  it("keeps a running installation and the checked release when the dialog is closed, even if one status check fails", async () => {
    const first = render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /ByoriDB 설치/ }));
    expect(await screen.findByText("내려받는 중", {}, { timeout: 3000 })).toBeInTheDocument();
    first.unmount();
    const before = calls("runtime.checkUpdate").length;
    let fail = true;
    const base = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (method, ...rest) => {
      if (method === "runtime.installStatus" && fail) {
        fail = false;
        throw new Error("일시적인 연결 오류");
      }
      return base(method, ...rest);
    });
    render(<Settings onClose={vi.fn()} onUpdate={vi.fn()} />);
    // Shown at once from what was last known, before any request returns.
    expect(screen.getByText("설치 진행 중")).toBeInTheDocument();
    expect(screen.getByText("내려받는 중")).toBeInTheDocument();
    expect(screen.getByText("v1.2.0")).toBeInTheDocument();
    expect(calls("runtime.checkUpdate")).toHaveLength(before);
    jobState = "completed";
    installed = true;
    expect(await screen.findByText("설치 완료", {}, { timeout: 4000 })).toBeInTheDocument();
  });
});
