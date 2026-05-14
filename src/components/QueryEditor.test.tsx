import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueryEditor from "./QueryEditor";

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
