import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import McpSettings from "./McpSettings";
import { rpc } from "./api";
vi.mock("./api", () => ({ rpc: vi.fn() }));
const initial = { added: false, enabled: false, phase: "unchecked", url: "https://mcp.higgsfield.ai/mcp", toolCount: 0, bridgeAvailable: true };
beforeEach(() => { vi.mocked(rpc).mockReset(); });
it("adds the connection without implicitly authenticating or generating", async () => {
  vi.mocked(rpc).mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, added: true, enabled: true });
  render(<McpSettings />);
  const add = await screen.findByRole("button", { name: "Higgsfield 추가" });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  expect(await screen.findByRole("button", { name: "로그인·연결 확인" })).toBeEnabled();
  expect(rpc).toHaveBeenNthCalledWith(2, "runtime.mcpSave", { enabled: true });
  expect(rpc).toHaveBeenCalledTimes(2);
});
it("only starts OAuth after connect and exposes cancellation", async () => {
  vi.mocked(rpc).mockResolvedValueOnce({ ...initial, added: true, enabled: true }).mockResolvedValue({ ...initial, added: true, enabled: true, phase: "connecting" });
  render(<McpSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "로그인·연결 확인" }));
  const cancel = await screen.findByRole("button", { name: "연결 취소" });
  expect(rpc).toHaveBeenCalledWith("runtime.mcpConnect", {});
  expect(screen.getByRole("checkbox")).toBeDisabled();
  fireEvent.click(cancel);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("runtime.mcpCancel", {}));
});
it("shows connection failures and allows removing saved credentials", async () => {
  vi.mocked(rpc).mockResolvedValueOnce({ ...initial, added: true, enabled: true, phase: "failed", error: "로그인을 완료해주세요" }).mockResolvedValue(initial);
  render(<McpSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("로그인을 완료해주세요");
  fireEvent.click(screen.getByRole("button", { name: "연결 삭제" }));
  await screen.findByRole("button", { name: "Higgsfield 추가" });
  expect(rpc).toHaveBeenCalledWith("runtime.mcpRemove", {});
});
