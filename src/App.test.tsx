import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@monaco-editor/react", async () => {
  const { useRef, useEffect } = await vi.importActual<typeof import("react")>("react");
  interface MockProps {
    value?: string;
    onChange?: (v: string) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
    options?: { readOnly?: boolean };
  }
  function MockEditor({ value = "", onChange, onMount, options }: MockProps) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const cmds = useRef<Map<number, () => void>>(new Map());
    useEffect(() => {
      if (!onMount) return;
      const KeyMod = { CtrlCmd: 1 << 11, Shift: 1 << 10 };
      const KeyCode = { Enter: 3, UpArrow: 16, DownArrow: 18 };
      onMount(
        {
          getValue: () => ref.current?.value ?? "",
          setValue: (v: string) => {
            onChange?.(v);
          },
          focus: () => ref.current?.focus(),
          getSelection: () => ({ isEmpty: () => true }),
          getModel: () => ({ getValueInRange: () => "" }),
          addCommand: (kb: number, h: () => void) => cmds.current.set(kb, h),
        },
        { KeyMod, KeyCode },
      );
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      let kb: number | null = null;
      if (e.key === "Enter") kb = (1 << 11) | 3;
      if (e.key === "ArrowUp") kb = (1 << 11) | 16;
      if (e.key === "ArrowDown") kb = (1 << 11) | 18;
      if (kb !== null) {
        e.preventDefault();
        cmds.current.get(kb)?.();
      }
    };
    return (
      <textarea
        ref={ref}
        data-testid="monaco-editor"
        value={value}
        disabled={options?.readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return { default: MockEditor };
});

vi.mock("./lib/ngql-language", () => ({ registerNgqlLanguage: vi.fn(), LANGUAGE_ID: "ngql" }));

vi.mock("./components/TableView", () => ({
  default: ({ result }: { result: { columns: string[]; rows: Record<string, unknown>[] } }) => (
    <table>
      <tbody>
        {result.rows.map((row, i) =>
          result.columns.map((col) => <td key={`${i}-${col}`}>{String(row[col] ?? "NULL")}</td>),
        )}
      </tbody>
    </table>
  ),
}));

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects, executes a query, and disconnects", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation((command: string) => {
      if (command === "connect" || command === "disconnect") {
        return Promise.resolve();
      }
      if (command === "get_spaces") {
        return Promise.resolve([]);
      }
      if (command === "execute_query") {
        return Promise.resolve({
          columns: ["name"],
          rows: [{ name: "alice" }],
          executionTime: 4,
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);

    await waitFor(() => expect(screen.getByText("127.0.0.1:19669")).toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith("connect", {
      config: {
        host: "127.0.0.1",
        port: 19669,
        username: "root",
        password: "",
      },
    });

    // Type query directly into the Monaco mock textarea
    await user.type(screen.getByRole("textbox"), "SHOW SPACES");
    await user.click(screen.getByTestId("execute-button"));

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith("execute_query", { query: "SHOW SPACES" });

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByText("Not connected")).toBeInTheDocument());
  });

  it("shows an alert when connecting fails", async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValueOnce("offline");

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith("Connection failed: offline");
    });
  });

  it("hints at BYORIDB_ROOT_PASSWORD when the server reports AUTH_FAILED", async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValueOnce({
      code: "AUTH_FAILED",
      message: "Authentication failed: Invalid password",
    });

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);

    await waitFor(() => {
      const alertCall = (window.alert as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(alertCall).toContain("Authentication failed: Invalid password");
      expect(alertCall).toContain("BYORIDB_ROOT_PASSWORD");
    });
  });

  it("renders query execution failures as result errors", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation((command: string) => {
      if (command === "connect") {
        return Promise.resolve();
      }
      if (command === "get_spaces") {
        return Promise.resolve([]);
      }
      if (command === "execute_query") {
        return Promise.reject("bad query");
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(screen.getByText("127.0.0.1:19669")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox"), "SHOW TAGS");
    await user.click(screen.getByTestId("execute-button"));

    await waitFor(() => expect(screen.getByText("Error")).toBeInTheDocument());
    expect(screen.getByText("bad query")).toBeInTheDocument();
  });

  it("disconnects and reopens the modal when a query reports SESSION_EXPIRED", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation((command: string) => {
      if (command === "connect") {
        return Promise.resolve();
      }
      if (command === "get_spaces") {
        return Promise.resolve([]);
      }
      if (command === "execute_query") {
        return Promise.reject({
          code: "SESSION_EXPIRED",
          message: "Session expired; please reconnect",
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(screen.getByText("127.0.0.1:19669")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox"), "SHOW TAGS");
    await user.click(screen.getByTestId("execute-button"));

    // Connection status reverts to disconnected…
    await waitFor(() => expect(screen.getByText("Not connected")).toBeInTheDocument());
    // …the connection modal reopens…
    expect(screen.getByText("Connect to ByoriDB")).toBeInTheDocument();
    // …and the result panel shows the friendly expiry message.
    expect(screen.getByText("Session expired. Please reconnect.")).toBeInTheDocument();
  });

  it("keeps modal open when close is requested before connecting", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: "×" }));

    expect(screen.getByText("Connect to ByoriDB")).toBeInTheDocument();
  });

  it("selects a space silently without overwriting the result panel", async () => {
    const user = userEvent.setup();

    const executeCalls: string[] = [];
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "connect") return Promise.resolve();
      if (command === "get_spaces") {
        return Promise.resolve([{ name: "demo", partitionNum: 10, replicaFactor: 1 }]);
      }
      if (command === "get_schema") {
        return Promise.resolve({ tags: [], edges: [] });
      }
      if (command === "execute_query") {
        executeCalls.push(String(args?.query));
        return Promise.resolve({
          columns: [],
          rows: [],
          executionTime: 1,
          rowCount: 0,
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(screen.getByText("demo")).toBeInTheDocument());

    await user.click(screen.getByText("demo"));

    await waitFor(() => expect(screen.getByText("/ demo")).toBeInTheDocument());
    expect(executeCalls).toEqual(["USE demo"]);
    // Result panel is still in its empty state — space switch didn't stomp it.
    expect(screen.getByText("Execute a query to see results")).toBeInTheDocument();
  });

  it("does not switch the current space when the USE command fails", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation((command: string) => {
      if (command === "connect") return Promise.resolve();
      if (command === "get_spaces") {
        return Promise.resolve([{ name: "restricted", partitionNum: 10, replicaFactor: 1 }]);
      }
      if (command === "get_schema") {
        return Promise.resolve({ tags: [], edges: [] });
      }
      if (command === "execute_query") {
        return Promise.reject({ code: "QUERY_ERROR", message: "Permission denied" });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    render(<App />);

    await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(screen.getByText("restricted")).toBeInTheDocument());

    await user.click(screen.getByText("restricted"));

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith(
        'Failed to switch to space "restricted": Permission denied',
      );
    });
    expect(screen.queryByText("/ restricted")).not.toBeInTheDocument();
  });

  it("drops the connection when the health poll reports the server as unreachable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

      let healthOk = true;
      invokeMock.mockImplementation((command: string) => {
        if (command === "connect") return Promise.resolve();
        if (command === "get_spaces") return Promise.resolve([]);
        if (command === "test_connection") return Promise.resolve(healthOk);
        return Promise.reject(new Error(`unexpected command ${command}`));
      });

      render(<App />);

      await user.click(screen.getAllByRole("button", { name: "Connect" })[0]);
      await waitFor(() => expect(screen.getByText("127.0.0.1:19669")).toBeInTheDocument());

      // Next health tick returns false → App should flip to disconnected.
      healthOk = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      await waitFor(() => expect(screen.getByText("Not connected")).toBeInTheDocument());
      expect(invokeMock).toHaveBeenCalledWith("test_connection", {
        host: "127.0.0.1",
        port: 19669,
      });
      expect(screen.getByText("Lost connection to server. Please reconnect.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
