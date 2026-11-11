import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";
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
});
