import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ServerSettings, { saveSavedConnections } from "./ServerSettings";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("ServerSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds, connects, edits, and deletes a saved connection", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();

    render(<ServerSettings onConnect={onConnect} />);

    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.type(screen.getByPlaceholderText("My Server"), "local");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("local")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:19669 (root)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 19669,
      username: "root",
      password: "",
    });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByDisplayValue("local");
    await user.clear(nameInput);
    await user.type(nameInput, "renamed");
    await user.click(screen.getByRole("button", { name: "Update" }));

    expect(screen.getByText("renamed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "×" }));
    expect(screen.getByText("No saved connections")).toBeInTheDocument();
  });

  it("tests saved connection success and failure states", async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("offline"));
    saveSavedConnections([
      {
        name: "local",
        config: {
          host: "127.0.0.1",
          port: 19669,
          username: "root",
          password: "test-password",
        },
      },
    ]);

    render(<ServerSettings onConnect={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("local")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("OK")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Failed")).toBeInTheDocument();
  });

  it("rejects empty and duplicate names", async () => {
    const user = userEvent.setup();

    saveSavedConnections([
      {
        name: "local",
        config: {
          host: "127.0.0.1",
          port: 19669,
          username: "root",
          password: "test-password",
        },
      },
    ]);

    render(<ServerSettings onConnect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(window.alert).toHaveBeenCalledWith("Please enter a connection name");

    await user.type(screen.getByPlaceholderText("My Server"), "local");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(window.alert).toHaveBeenCalledWith("A connection with this name already exists");
  });

  it("tests a form connection and resets the form with cancel", async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValueOnce(true);

    render(<ServerSettings onConnect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Connection successful!")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("No saved connections")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows form connection test failure and uses default port for invalid input", async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValueOnce(new Error("offline"));

    render(<ServerSettings onConnect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.clear(screen.getByPlaceholderText("19669"));
    await user.type(screen.getByPlaceholderText("19669"), "abc");
    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(invokeMock).toHaveBeenCalledWith("test_connection", {
      host: "127.0.0.1",
      port: 19669,
    });
    expect(await screen.findByText("Connection failed")).toBeInTheDocument();
  });

  it("keeps a connection when delete confirmation is declined", async () => {
    const user = userEvent.setup();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    saveSavedConnections([
      {
        name: "local",
        config: {
          host: "127.0.0.1",
          port: 19669,
          username: "root",
          password: "test-password",
        },
      },
    ]);

    render(<ServerSettings onConnect={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("local")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "×" }));

    expect(screen.getByText("local")).toBeInTheDocument();
  });
});
