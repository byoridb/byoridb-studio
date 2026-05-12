import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectionModal from "./ConnectionModal";
import { saveSavedConnections } from "./ServerSettings";

describe("ConnectionModal", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits the default connection config", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockResolvedValue(undefined);

    render(<ConnectionModal onConnect={onConnect} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 19669,
      username: "root",
      password: "cah",
    });
  });

  it("loads saved connections and lets the user select one", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockResolvedValue(undefined);

    saveSavedConnections([
      {
        name: "remote",
        config: {
          host: "10.0.0.5",
          port: 19700,
          username: "admin",
          password: "secret",
        },
      },
    ]);

    render(<ConnectionModal onConnect={onConnect} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("remote")).toBeInTheDocument());
    await user.click(screen.getByText("remote"));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({
      host: "10.0.0.5",
      port: 19700,
      username: "admin",
      password: "secret",
    });
  });

  it("calls onClose from the close and cancel buttons", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<ConnectionModal onConnect={vi.fn()} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "×" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("updates connection fields and falls back to the default port for invalid input", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockResolvedValue(undefined);

    render(<ConnectionModal onConnect={onConnect} onClose={vi.fn()} />);

    await user.clear(screen.getByPlaceholderText("127.0.0.1"));
    await user.type(screen.getByPlaceholderText("127.0.0.1"), "db.internal");
    await user.clear(screen.getByPlaceholderText("19669"));
    await user.type(screen.getByPlaceholderText("19669"), "abc");
    await user.clear(screen.getByPlaceholderText("root"));
    await user.type(screen.getByPlaceholderText("root"), "tester");
    await user.clear(screen.getByPlaceholderText("Enter password"));
    await user.type(screen.getByPlaceholderText("Enter password"), "pw");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({
      host: "db.internal",
      port: 19669,
      username: "tester",
      password: "pw",
    });
  });

  it("resets connecting state when onConnect fails", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockRejectedValue(new Error("offline"));

    render(<ConnectionModal onConnect={onConnect} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(console.error).toHaveBeenCalledWith("Connection failed:", expect.any(Error));
    expect(screen.getByRole("button", { name: "Connect" })).not.toBeDisabled();
  });
});
