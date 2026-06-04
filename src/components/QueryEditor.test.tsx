import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueryEditor from "./QueryEditor";

// ---------------------------------------------------------------------------
// Monaco mock
// ---------------------------------------------------------------------------

interface MockEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  onMount?: (editor: MockEditorInstance, monaco: unknown) => void;
  options?: { readOnly?: boolean };
}

interface MockEditorInstance {
  getValue: () => string;
  setValue: (v: string) => void;
  focus: () => void;
  getSelection: () => { isEmpty: () => boolean } | null;
  getModel: () => { getValueInRange: (sel: unknown) => string; getValue: () => string } | null;
  addCommand: (keybinding: number, handler: () => void) => void;
  onDidChangeModelContent: (cb: () => void) => { dispose: () => void };
}

const KeyMod = { CtrlCmd: 1 << 11, Shift: 1 << 10 };
const KeyCode = { Enter: 3, UpArrow: 16, DownArrow: 18 };
const MarkerSeverity = { Error: 8, Warning: 4 };

vi.mock("@monaco-editor/react", async () => {
  const { useRef, useEffect } = await vi.importActual<typeof import("react")>("react");

  function MockEditor({ value = "", onChange, onMount, options }: MockEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const commandsRef = useRef<Map<number, () => void>>(new Map());

    useEffect(() => {
      if (!onMount) return;
      const editor: MockEditorInstance = {
        getValue: () => textareaRef.current?.value ?? "",
        setValue: (v: string) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          setter?.call(textareaRef.current, v);
          textareaRef.current?.dispatchEvent(new Event("input", { bubbles: true }));
          onChange?.(v);
        },
        focus: () => textareaRef.current?.focus(),
        getSelection: () => ({ isEmpty: () => true }),
        getModel: () => ({
          getValueInRange: () => "",
          getValue: () => textareaRef.current?.value ?? "",
        }),
        addCommand: (keybinding: number, handler: () => void) => {
          commandsRef.current.set(keybinding, handler);
        },
        onDidChangeModelContent: () => ({ dispose: () => {} }),
      };
      onMount(editor, {
        KeyMod,
        KeyCode,
        MarkerSeverity,
        editor: { setModelMarkers: () => {} },
      });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      let kb: number | null = null;
      if (e.key === "Enter" && e.shiftKey) kb = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter;
      else if (e.key === "Enter") kb = KeyMod.CtrlCmd | KeyCode.Enter;
      else if (e.key === "ArrowUp") kb = KeyMod.CtrlCmd | KeyCode.UpArrow;
      else if (e.key === "ArrowDown") kb = KeyMod.CtrlCmd | KeyCode.DownArrow;
      if (kb !== null) {
        e.preventDefault();
        commandsRef.current.get(kb)?.();
      }
    };

    return (
      <textarea
        ref={textareaRef}
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

vi.mock("../lib/ngql-language", () => ({
  registerNgqlLanguage: vi.fn(),
  LANGUAGE_ID: "ngql",
  setPropertyLoader: vi.fn(),
  schemaContext: { tags: [], edges: [], spaces: [], properties: {} },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QueryEditor", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("disables editing and execution while disconnected", () => {
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected={false} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByTestId("execute-button")).toBeDisabled();
  });

  it("executes query from button and saves history", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    render(<QueryEditor onExecute={onExecute} isExecuting={false} isConnected />);

    await user.type(screen.getByRole("textbox"), "SHOW SPACES");
    await user.click(screen.getByTestId("execute-button"));

    expect(onExecute).toHaveBeenCalledWith("SHOW SPACES");
    expect(localStorage.getItem("byoridb-studio-query-history")).toBe('["SHOW SPACES"]');
  });

  it("executes with ⌘↵ and deduplicates history", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    render(<QueryEditor onExecute={onExecute} isExecuting={false} isConnected />);

    await user.type(screen.getByRole("textbox"), "MATCH (v) RETURN v");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("byoridb-studio-query-history")).toBe('["MATCH (v) RETURN v"]');
  });

  it("navigates history with ⌘↑/↓", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "byoridb-studio-query-history",
      JSON.stringify(["SHOW TAGS", "SHOW EDGES"]),
    );
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);

    const editor = screen.getByRole("textbox");
    await user.click(editor);
    await user.keyboard("{Meta>}{ArrowUp}{/Meta}");
    expect(editor).toHaveValue("SHOW TAGS");
    await user.keyboard("{Meta>}{ArrowUp}{/Meta}");
    expect(editor).toHaveValue("SHOW EDGES");
    await user.keyboard("{Meta>}{ArrowDown}{/Meta}");
    expect(editor).toHaveValue("SHOW TAGS");
  });

  it("clears the editor", async () => {
    const user = userEvent.setup();
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);
    await user.type(screen.getByRole("textbox"), "SHOW HOSTS");
    await user.click(screen.getByTestId("clear-button"));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("does not execute blank queries", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    render(<QueryEditor onExecute={onExecute} isExecuting={false} isConnected />);
    await user.type(screen.getByRole("textbox"), "   ");
    expect(screen.getByTestId("execute-button")).toBeDisabled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("shows executing state", () => {
    render(<QueryEditor onExecute={vi.fn()} isExecuting isConnected />);
    expect(screen.getByTestId("execute-button")).toBeDisabled();
    expect(screen.getByTestId("execute-button")).toHaveTextContent("Executing...");
  });

  it("navigates back to empty query", async () => {
    const user = userEvent.setup();
    localStorage.setItem("byoridb-studio-query-history", JSON.stringify(["SHOW TAGS"]));
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);
    const editor = screen.getByRole("textbox");
    await user.click(editor);
    await user.keyboard("{Meta>}{ArrowUp}{/Meta}");
    expect(editor).toHaveValue("SHOW TAGS");
    await user.keyboard("{Meta>}{ArrowDown}{/Meta}");
    expect(editor).toHaveValue("");
  });

  it("keeps only 50 newest unique history entries", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "byoridb-studio-query-history",
      JSON.stringify(Array.from({ length: 50 }, (_, i) => `QUERY ${i}`)),
    );
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);
    await user.type(screen.getByRole("textbox"), "NEW QUERY");
    await user.click(screen.getByTestId("execute-button"));
    const history = JSON.parse(
      localStorage.getItem("byoridb-studio-query-history") ?? "[]",
    ) as string[];
    expect(history).toHaveLength(50);
    expect(history[0]).toBe("NEW QUERY");
  });

  // Phase 2.3: tabs
  it("adds a new tab", async () => {
    const user = userEvent.setup();
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);
    await user.click(screen.getByTestId("add-tab"));
    expect(screen.getAllByText("Query")).toHaveLength(2);
  });

  // Phase 2.3: snippets
  it("inserts a snippet into the editor", async () => {
    const user = userEvent.setup();
    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);
    await user.click(screen.getByTestId("snippets-button"));
    expect(screen.getByTestId("snippet-dropdown")).toBeInTheDocument();
    await user.click(screen.getByText("SHOW SPACES"));
    expect(screen.getByRole("textbox")).toHaveValue("SHOW SPACES");
  });
});
