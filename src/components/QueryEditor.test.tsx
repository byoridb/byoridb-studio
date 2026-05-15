import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueryEditor from "./QueryEditor";

// ---------------------------------------------------------------------------
// Monaco mock
// ---------------------------------------------------------------------------
// @monaco-editor/react renders a full Monaco instance which requires a real
// browser DOM. In jsdom we replace it with a plain <textarea> that exposes
// the same value/onChange surface and simulates the keybindings the component
// registers via editor.addCommand().
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
  addCommand: (keybinding: number, handler: () => void) => void;
}

// Keybinding constants mirroring Monaco's KeyMod / KeyCode values
const KeyMod = { CtrlCmd: 1 << 11 };
const KeyCode = { Enter: 3, UpArrow: 16, DownArrow: 18 };

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
          if (textareaRef.current) {
            // Simulate React-controlled update
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              "value",
            )?.set;
            nativeInputValueSetter?.call(textareaRef.current, v);
            textareaRef.current.dispatchEvent(new Event("input", { bubbles: true }));
          }
          onChange?.(v);
        },
        focus: () => textareaRef.current?.focus(),
        addCommand: (keybinding: number, handler: () => void) => {
          commandsRef.current.set(keybinding, handler);
        },
      };

      const monacoStub = { KeyMod, KeyCode };
      onMount(editor, monacoStub);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      let keybinding: number | null = null;
      if (e.key === "Enter") keybinding = KeyMod.CtrlCmd | KeyCode.Enter;
      if (e.key === "ArrowUp") keybinding = KeyMod.CtrlCmd | KeyCode.UpArrow;
      if (e.key === "ArrowDown") keybinding = KeyMod.CtrlCmd | KeyCode.DownArrow;
      if (keybinding !== null) {
        e.preventDefault();
        commandsRef.current.get(keybinding)?.();
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
    expect(screen.getByRole("button", { name: /Execute/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show Spaces" })).toBeDisabled();
  });

  it("loads a sample query and executes it from the button", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();

    render(<QueryEditor onExecute={onExecute} isExecuting={false} isConnected />);

    await user.click(screen.getByRole("button", { name: "Show Spaces" }));
    expect(screen.getByRole("textbox")).toHaveValue("SHOW SPACES");

    await user.click(screen.getByRole("button", { name: /Execute/ }));

    expect(onExecute).toHaveBeenCalledWith("SHOW SPACES");
    expect(localStorage.getItem("byoridb-studio-query-history")).toBe('["SHOW SPACES"]');
  });

  it("executes with keyboard shortcut and deduplicates history", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();

    render(<QueryEditor onExecute={onExecute} isExecuting={false} isConnected />);

    await user.type(screen.getByRole("textbox"), "MATCH (v) RETURN v");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("byoridb-studio-query-history")).toBe('["MATCH (v) RETURN v"]');
  });

  it("navigates saved query history", async () => {
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

  it("clears the current query", async () => {
    const user = userEvent.setup();

    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);

    await user.type(screen.getByRole("textbox"), "SHOW HOSTS");
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("does not execute blank queries or while already executing", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();

    const { rerender } = render(
      <QueryEditor onExecute={onExecute} isExecuting={false} isConnected />,
    );

    await user.type(screen.getByRole("textbox"), "   ");
    expect(screen.getByRole("button", { name: /Execute/ })).toBeDisabled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onExecute).not.toHaveBeenCalled();

    rerender(<QueryEditor onExecute={onExecute} isExecuting isConnected />);
    expect(screen.getByRole("button", { name: "Executing..." })).toBeDisabled();
  });

  it("navigates back past the newest history entry to an empty query", async () => {
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

  it("keeps only the 50 newest unique history entries", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "byoridb-studio-query-history",
      JSON.stringify(Array.from({ length: 50 }, (_, i) => `QUERY ${i}`)),
    );

    render(<QueryEditor onExecute={vi.fn()} isExecuting={false} isConnected />);

    await user.type(screen.getByRole("textbox"), "NEW QUERY");
    await user.click(screen.getByRole("button", { name: /Execute/ }));

    const history = JSON.parse(
      localStorage.getItem("byoridb-studio-query-history") ?? "[]",
    ) as string[];
    expect(history).toHaveLength(50);
    expect(history[0]).toBe("NEW QUERY");
    expect(history).not.toContain("QUERY 49");
  });
});
