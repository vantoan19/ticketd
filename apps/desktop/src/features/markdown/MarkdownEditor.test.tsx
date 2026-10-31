// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
vi.mock("./MermaidDiagram", () => ({
  MermaidDiagram: () => <div>Diagram preview</div>,
}));
afterEach(cleanup);
describe("Markdown draft editor", () => {
  it("retains original source without emitting on mount, focus, blur or ordinary rerender", () => {
    const source =
      "###   Keep exact opening source\n\n- [x] Done\n\n3. Third\n";
    const onChange = vi.fn();
    const view = render(<MarkdownEditor value={source} onChange={onChange} />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    fireEvent.focus(editable);
    fireEvent.blur(editable);
    view.rerender(<MarkdownEditor value={source} onChange={onChange} />);
    expect(
      screen.getByRole("textbox", { name: "Markdown document rich text" }),
    ).toBe(editable);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("enforces read-only content and hides editing controls", () => {
    render(<MarkdownEditor value="View only" onChange={vi.fn()} readOnly />);
    expect(
      screen
        .getByLabelText("Markdown document rich text")
        .getAttribute("contenteditable"),
    ).toBe("false");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("accepts an explicit controlled reset without treating it as a user edit", async () => {
    const onChange = vi.fn();
    const view = render(
      <MarkdownEditor value="Original draft" onChange={onChange} />,
    );
    view.rerender(
      <MarkdownEditor value="Resolved external content" onChange={onChange} />,
    );
    await screen.findByText("Resolved external content");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("locks and unlocks an already-mounted document during submission", () => {
    const onChange = vi.fn();
    const view = render(
      <MarkdownEditor value="Pending note" onChange={onChange} />,
    );
    view.rerender(
      <MarkdownEditor value="Pending note" onChange={onChange} readOnly />,
    );
    expect(
      screen
        .getByLabelText("Markdown document rich text")
        .getAttribute("contenteditable"),
    ).toBe("false");
    view.rerender(<MarkdownEditor value="Pending note" onChange={onChange} />);
    expect(
      screen
        .getByLabelText("Markdown document rich text")
        .getAttribute("contenteditable"),
    ).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows ordered-list starts and link destinations in the rich document", () => {
    render(
      <MarkdownEditor
        value={'3. Third\n\n[Example](https://example.com "Title")\n'}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("list").getAttribute("start")).toBe("3");
    expect(
      screen.getByRole("link", { name: "Example" }).getAttribute("href"),
    ).toBe("https://example.com");
  });
});
