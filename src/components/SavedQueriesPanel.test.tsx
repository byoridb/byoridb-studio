import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SavedQueriesPanel from "./SavedQueriesPanel";
import type { SavedQuery } from "../types";

const queries: SavedQuery[] = [
  { id: "1", name: "Recent people", query: "MATCH (n:person) RETURN n LIMIT 10", createdAt: 1 },
  { id: "2", name: "All edges", query: "SHOW EDGES", createdAt: 2 },
];

describe("SavedQueriesPanel", () => {
  it("renders nothing when there are no saved queries", () => {
    const { container } = render(
      <SavedQueriesPanel queries={[]} onSelect={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists saved query names", () => {
    render(<SavedQueriesPanel queries={queries} onSelect={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("Recent people")).toBeInTheDocument();
    expect(screen.getByText("All edges")).toBeInTheDocument();
  });

  it("calls onSelect with the query text on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SavedQueriesPanel queries={queries} onSelect={onSelect} onDelete={vi.fn()} />);
    await user.click(screen.getByTestId("saved-query-1"));
    expect(onSelect).toHaveBeenCalledWith("MATCH (n:person) RETURN n LIMIT 10");
  });

  it("calls onDelete without triggering onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(<SavedQueriesPanel queries={queries} onSelect={onSelect} onDelete={onDelete} />);
    await user.click(screen.getByTestId("saved-query-delete-1"));
    expect(onDelete).toHaveBeenCalledWith("1");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
