import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Sidebar from "./Sidebar";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads spaces, selects a space, and executes schema shortcuts", async () => {
    const user = userEvent.setup();
    const onSelectSpace = vi.fn();
    const onExecuteQuery = vi.fn();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_spaces") {
        return Promise.resolve([{ name: "demo", partitionNum: 10, replicaFactor: 1 }]);
      }
      if (command === "get_schema") {
        return Promise.resolve({ tags: ["person"], edges: ["likes"] });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    const { rerender } = render(
      <Sidebar
        isConnected
        currentSpace={null}
        onSelectSpace={onSelectSpace}
        onExecuteQuery={onExecuteQuery}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());
    await user.click(screen.getByText("demo"));
    expect(onSelectSpace).toHaveBeenCalledWith("demo");

    rerender(
      <Sidebar
        isConnected
        currentSpace="demo"
        onSelectSpace={onSelectSpace}
        onExecuteQuery={onExecuteQuery}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("person")).toBeInTheDocument());
    await user.click(screen.getByText("person"));
    expect(onExecuteQuery).toHaveBeenCalledWith("MATCH (v:person) RETURN v LIMIT 100");

    await user.click(screen.getByText("likes"));
    expect(onExecuteQuery).toHaveBeenCalledWith("MATCH (s)-[e:likes]->() RETURN e LIMIT 100");
  });

  it("switches to settings tab", async () => {
    const user = userEvent.setup();

    render(
      <Sidebar
        isConnected={false}
        currentSpace={null}
        onSelectSpace={vi.fn()}
        onExecuteQuery={vi.fn()}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("Server Connections")).toBeInTheDocument();
  });

  it("collapses and refreshes spaces without selecting a space", async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValue([{ name: "demo", partitionNum: 10, replicaFactor: 1 }]);

    render(
      <Sidebar
        isConnected
        currentSpace={null}
        onSelectSpace={vi.fn()}
        onExecuteQuery={vi.fn()}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());
    await user.click(screen.getByText("Spaces"));
    expect(screen.queryByText("demo")).not.toBeInTheDocument();

    await user.click(screen.getByText("Spaces"));
    await user.click(screen.getByTitle("Refresh"));
    expect(invokeMock).toHaveBeenCalledWith("get_spaces");
  });

  it("handles loading failures by keeping empty states", async () => {
    invokeMock.mockRejectedValue(new Error("offline"));

    render(
      <Sidebar
        isConnected
        currentSpace="demo"
        onSelectSpace={vi.fn()}
        onExecuteQuery={vi.fn()}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith("Failed to load spaces:", expect.any(Error));
    });
    expect(screen.getByText("No spaces found")).toBeInTheDocument();
    expect(screen.getByText("No tags found")).toBeInTheDocument();
    expect(screen.getByText("No edges found")).toBeInTheDocument();
  });

  it("lazy-loads DESCRIBE TAG on expand and caches the result", async () => {
    const user = userEvent.setup();
    let describeCalls = 0;

    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_spaces") {
        return Promise.resolve([{ name: "demo", partitionNum: 10, replicaFactor: 1 }]);
      }
      if (command === "get_schema") {
        return Promise.resolve({ tags: ["person"], edges: [] });
      }
      if (command === "execute_query" && String(args?.query).startsWith("DESCRIBE TAG")) {
        describeCalls++;
        return Promise.resolve({
          columns: ["Field", "Type", "Null", "Default"],
          rows: [
            { Field: "name", Type: "STRING", Null: "NO", Default: null },
            { Field: "age", Type: "INT64", Null: "YES", Default: 0 },
          ],
          executionTime: 1,
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(
      <Sidebar
        isConnected
        currentSpace="demo"
        onSelectSpace={vi.fn()}
        onExecuteQuery={vi.fn()}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("person")).toBeInTheDocument());

    // Expand the tag -> DESCRIBE TAG person fires once, table appears.
    await user.click(screen.getByRole("button", { name: /Expand person/ }));

    await waitFor(() => expect(screen.getByText("STRING")).toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith("execute_query", { query: "DESCRIBE TAG person" });
    expect(screen.getByText("INT64")).toBeInTheDocument();
    // Default null renders as em-dash, non-null values render as strings.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(describeCalls).toBe(1);

    // Collapse → table goes away but cache retained.
    await user.click(screen.getByRole("button", { name: /Collapse person/ }));
    expect(screen.queryByText("STRING")).not.toBeInTheDocument();

    // Re-expand → no new DESCRIBE call.
    await user.click(screen.getByRole("button", { name: /Expand person/ }));
    await waitFor(() => expect(screen.getByText("STRING")).toBeInTheDocument());
    expect(describeCalls).toBe(1);
  });

  it("surfaces DESCRIBE errors inline without affecting name-click behavior", async () => {
    const user = userEvent.setup();
    const onExecuteQuery = vi.fn();

    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_spaces") {
        return Promise.resolve([{ name: "demo", partitionNum: 10, replicaFactor: 1 }]);
      }
      if (command === "get_schema") {
        return Promise.resolve({ tags: ["ghost"], edges: [] });
      }
      if (command === "execute_query" && String(args?.query).startsWith("DESCRIBE TAG")) {
        return Promise.reject({
          code: "QUERY_ERROR",
          message: "Tag ghost not found",
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(
      <Sidebar
        isConnected
        currentSpace="demo"
        onSelectSpace={vi.fn()}
        onExecuteQuery={onExecuteQuery}
        onConnect={vi.fn()}
        historyEntries={[]}
        onToggleFavorite={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("ghost")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Expand ghost/ }));

    await waitFor(() => expect(screen.getByText("Error: Tag ghost not found")).toBeInTheDocument());

    // Name click is independent of the DESCRIBE panel and still fires the MATCH shortcut.
    await user.click(screen.getByText("ghost"));
    expect(onExecuteQuery).toHaveBeenCalledWith("MATCH (v:ghost) RETURN v LIMIT 100");
  });
});
