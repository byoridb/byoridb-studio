import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueryBuilderPanel from "./QueryBuilderPanel";

const schema = { tags: ["person", "company"], edges: ["knows", "works_at"] };

describe("QueryBuilderPanel", () => {
  it("prompts to create a tag when the schema is empty", () => {
    render(<QueryBuilderPanel schema={{ tags: [], edges: [] }} onRun={vi.fn()} />);
    expect(screen.getByText(/No tags in this space/)).toBeInTheDocument();
  });

  it("generates a MATCH query as the form is filled and runs it", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<QueryBuilderPanel schema={schema} onRun={onRun} />);

    // Run is disabled until a start tag is chosen.
    expect(screen.getByTestId("qb-run")).toBeDisabled();

    await user.selectOptions(screen.getByTestId("qb-start-tag"), "person");
    expect(screen.getByTestId("qb-preview")).toHaveTextContent(
      "MATCH (a:person) RETURN a LIMIT 100",
    );

    await user.click(screen.getByTestId("qb-run"));
    expect(onRun).toHaveBeenCalledWith("MATCH (a:person) RETURN a LIMIT 100");
  });

  it("adds a relationship to the generated pattern", async () => {
    const user = userEvent.setup();
    render(<QueryBuilderPanel schema={schema} onRun={vi.fn()} />);

    await user.selectOptions(screen.getByTestId("qb-start-tag"), "person");
    await user.click(screen.getByTestId("qb-edge-toggle"));
    await user.selectOptions(screen.getByTestId("qb-edge-name"), "knows");
    await user.selectOptions(screen.getByTestId("qb-end-tag"), "person");

    expect(screen.getByTestId("qb-preview")).toHaveTextContent(
      "MATCH (a:person)-[e:knows]->(b:person) RETURN a, b LIMIT 100",
    );
  });

  it("adds a WHERE condition", async () => {
    const user = userEvent.setup();
    render(<QueryBuilderPanel schema={schema} onRun={vi.fn()} />);

    await user.selectOptions(screen.getByTestId("qb-start-tag"), "person");
    await user.click(screen.getByTestId("qb-add-condition"));
    await user.type(screen.getByTestId("qb-cond-prop-0"), "name");
    await user.type(screen.getByTestId("qb-cond-value-0"), "Alice");

    expect(screen.getByTestId("qb-preview")).toHaveTextContent(
      'MATCH (a:person) WHERE a.name == "Alice" RETURN a LIMIT 100',
    );
  });
});
