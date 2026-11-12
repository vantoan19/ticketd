// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import { slashChoices, slashMayOpen } from "./slash-menu";
vi.mock("./MermaidDiagram", () => ({
  MermaidDiagram: () => <div>Diagram preview</div>,
}));
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "isContentEditable");
});
describe("Markdown draft editor", () => {
  it("returns focus to the editor when a focus request is raised (D2)", async () => {
    const onChange = vi.fn();
    const view = render(<MarkdownEditor value="Draft" onChange={onChange} />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    expect(document.activeElement).not.toBe(editable);
    view.rerender(
      <MarkdownEditor value="Draft" onChange={onChange} focusRequest={1} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(editable));
  });
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
  it("announces the keyboard-selected slash option while retaining focus and cancels for composition", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    // jsdom does not implement the browser contenteditable property Slate checks.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    editable.focus();
    fireEvent.keyDown(editable, { key: "/" });
    const combo = screen.getByRole("combobox", {
      name: "Markdown document rich text",
    });
    const menu = screen.getByRole("listbox", { name: "Insert block" });
    expect(combo.getAttribute("aria-controls")).toBe(menu.id);
    expect(combo.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById(combo.getAttribute("aria-activedescendant") ?? "")
        ?.textContent,
    ).toBe("Paragraph");
    fireEvent.keyDown(combo, { key: "ArrowDown" });
    expect(
      document.getElementById(combo.getAttribute("aria-activedescendant") ?? "")
        ?.textContent,
    ).toBe("Heading 1");
    expect(document.activeElement).toBe(combo);
    fireEvent.keyDown(combo, { key: "h" });
    expect(
      document.getElementById(combo.getAttribute("aria-activedescendant") ?? "")
        ?.textContent,
    ).toBe("Heading 1");
    fireEvent.compositionStart(combo);
    fireEvent.keyDown(combo, { key: "/", isComposing: true, keyCode: 229 });
    expect(screen.queryByRole("listbox", { name: "Insert block" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("changes a code fence language without changing its source and retains unknown languages", async () => {
    const onChange = vi.fn();
    function Draft() {
      const [value, setValue] = useState(
        '```unknown-language\nconst message = "$& 日本語";\n```\n',
      );
      return (
        <MarkdownEditor
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Draft />);
    const language = screen.getByRole("combobox", { name: "Code language" });
    expect(language).toHaveProperty("value", "unknown-language");
    fireEvent.change(language, { target: { value: "typescript" } });
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        '```typescript\nconst message = "$& 日本語";\n```',
      ),
    );
    fireEvent.change(language, { target: { value: "my-dsl" } });
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        '```my-dsl\nconst message = "$& 日本語";\n```',
      ),
    );
    const calls = onChange.mock.calls.length;
    fireEvent.change(language, { target: { value: "rust title=metadata" } });
    fireEvent.change(language, { target: { value: "```" } });
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect(language).toHaveProperty("value", "my-dsl");
  });
  it("rejects foreign and malformed block drag payloads without changing the draft", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"First\n\nSecond\n"} onChange={onChange} />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    const target = screen.getByText("Second");
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    // jsdom has no pointer-to-caret API; the real DOM range is the drop target.
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: () => range,
    });
    for (const data of [
      "0",
      '{"editorId":"another-editor","index":0}',
      '{"index":-1}',
      "not-json",
    ]) {
      const event = new MouseEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      });
      Object.defineProperty(event, "dataTransfer", {
        value: { getData: () => data, types: ["application/x-ticketd-block"] },
      });
      await act(async () => {
        fireEvent(target, event);
      });
      expect(editable.textContent).toBe("FirstSecond");
      expect(onChange).not.toHaveBeenCalled();
    }
    Reflect.deleteProperty(document, "caretRangeFromPoint");
  });
  it("opens the slash menu only at the start of a block or after whitespace", () => {
    expect(slashMayOpen("")).toBe(true);
    expect(slashMayOpen("See ")).toBe(true);
    expect(slashMayOpen("See https://example.com")).toBe(false);
    expect(slashMayOpen("a")).toBe(false);
  });
  it("matches slash commands by title prefix only", () => {
    expect(slashChoices("tab").map(([type]) => type)).toEqual(["table"]);
    expect(slashChoices("ist")).toEqual([]);
    expect(slashChoices("").length).toBeGreaterThan(5);
  });
  it("closes the slash menu on a non-matching key, whitespace and blur, and resets it", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    Object.defineProperty(editable, "isContentEditable", { value: true });
    editable.focus();
    const open = () => {
      fireEvent.keyDown(editable, { key: "/" });
      expect(screen.getByRole("listbox")).toBeTruthy();
    };
    open();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "t" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "z" });
    expect(screen.queryByRole("listbox")).toBeNull();
    open();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: " " });
    expect(screen.queryByRole("listbox")).toBeNull();
    open();
    fireEvent.blur(editable);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(editable, { key: "/" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByText("No matching blocks")).toBeNull();
  });
  it("inserts a divider from the slash menu", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    Object.defineProperty(editable, "isContentEditable", { value: true });
    editable.focus();
    fireEvent.keyDown(editable, { key: "/" });
    fireEvent.click(screen.getByRole("option", { name: "Divider" }));
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.stringMatching(/^\s*\*\*\*\s*$/),
      ),
    );
  });
  /** Mounts a controlled editor with the caret at `offset` inside the text `text`. */
  async function mountWithCaret(text: string, offset: number) {
    const changes = vi.fn();
    function Draft() {
      const [value, setValue] = useState(text);
      return (
        <MarkdownEditor
          value={value}
          onChange={(next) => {
            setValue(next);
            changes(next);
          }}
        />
      );
    }
    render(<Draft />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    // jsdom has no contenteditable support; Slate asks each node whether it is editable.
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest('[contenteditable="true"]') !== null;
      },
    });
    editable.focus();
    const range = document.createRange();
    range.setStart(screen.getByText(text).firstChild!, offset);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    return { editable, changes };
  }
  it("keeps the caret inside a Quote chosen from the slash menu", async () => {
    const { editable } = await mountWithCaret("x y", 2);
    fireEvent.keyDown(editable, { key: "/" });
    fireEvent.click(screen.getByRole("option", { name: "Quote" }));
    await waitFor(() => {
      const quote = editable.querySelector("blockquote");
      expect(quote).not.toBeNull();
      const selection = window.getSelection();
      expect(selection?.rangeCount).toBe(1);
      expect(quote?.contains(selection?.anchorNode ?? null)).toBe(true);
    });
  });
  it("keeps the leading whitespace of pasted plain text", async () => {
    const { editable, changes } = await mountWithCaret("hello", 5);
    const paste = (text: string) => {
      const event = createEvent.paste(editable);
      Object.defineProperty(event, "clipboardData", {
        value: { getData: () => text },
      });
      fireEvent(editable, event);
    };
    paste(" world");
    await waitFor(() =>
      expect(changes).toHaveBeenLastCalledWith("hello world"),
    );
  });
  it("keeps edge whitespace of a multi-paragraph paste", async () => {
    const { editable, changes } = await mountWithCaret("hi", 2);
    const event = createEvent.paste(editable);
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => " one\n\n two " },
    });
    fireEvent(editable, event);
    await waitFor(() =>
      expect(changes).toHaveBeenLastCalledWith("hi one\n\ntwo"),
    );
  });
  it("does not let pasted edge whitespace inherit a mark", async () => {
    const { editable, changes } = await mountWithCaret("pre", 3);
    const event = createEvent.paste(editable);
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => " **b** and _i_ " },
    });
    fireEvent(editable, event);
    await waitFor(() =>
      expect(changes).toHaveBeenLastCalledWith("pre **b** and *i*"),
    );
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

describe("Formatting toolbar", () => {
  it("shows only while the editor has focus and offers an icon-only copy button", () => {
    render(<MarkdownEditor value="text" onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
    expect(screen.queryByText(/^Copy .* Markdown$/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy Markdown document Markdown" }),
    ).toBeTruthy();
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    fireEvent.focus(editable);
    expect(screen.getByRole("button", { name: "Bold" })).toBeTruthy();
    fireEvent.blur(editable);
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
  });
  it("keeps editor focus on pointer down for the Link button", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    fireEvent.focus(
      screen.getByRole("textbox", { name: "Markdown document rich text" }),
    );
    const down = createEvent.mouseDown(
      screen.getByRole("button", { name: "Link" }),
    );
    fireEvent(screen.getByRole("button", { name: "Link" }), down);
    expect(down.defaultPrevented).toBe(true);
  });
});

describe("Toolbar layout and links", () => {
  it("keeps the toolbar in layout when blurred so a first click lands", () => {
    const { container } = render(
      <MarkdownEditor value="text" onChange={vi.fn()} />,
    );
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    fireEvent.focus(editable);
    const toolbar = container.querySelector(".rich-toolbar");
    expect(toolbar?.getAttribute("data-visible")).toBe("true");
    fireEvent.blur(editable);
    expect(container.querySelector(".rich-toolbar")).toBe(toolbar);
    expect(toolbar?.hasAttribute("hidden")).toBe(false);
    expect(toolbar?.getAttribute("data-visible")).toBe("false");
    expect(toolbar?.hasAttribute("inert")).toBe(true);
  });
  it("floats a focus-only toolbar above the frame but keeps a persistent one in it (L6)", () => {
    const idle = render(<MarkdownEditor value="text" onChange={vi.fn()} />);
    expect(
      idle.container
        .querySelector(".rich-toolbar")
        ?.hasAttribute("data-floating"),
    ).toBe(true);
    idle.unmount();
    const kept = render(
      <MarkdownEditor value="text" onChange={vi.fn()} persistentToolbar />,
    );
    expect(
      kept.container
        .querySelector(".rich-toolbar")
        ?.hasAttribute("data-floating"),
    ).toBe(false);
  });
  it("offers one row of essentials and keeps the rest in More", () => {
    render(<MarkdownEditor value="text" onChange={vi.fn()} />);
    fireEvent.focus(
      screen.getByRole("textbox", { name: "Markdown document rich text" }),
    );
    const names = within(screen.getByRole("toolbar"))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Bold",
      "Italic",
      "Insert attachment",
      "Link",
      "Bullet list",
      "Checklist",
      "Inline code",
      "More formatting",
    ]);
  });
  it("shows the placeholder only while the editor is empty (K10)", async () => {
    const Harness = () => {
      const [value, setValue] = useState("");
      return (
        <MarkdownEditor
          value={value}
          onChange={setValue}
          placeholder="Write a thought…"
        />
      );
    };
    render(<Harness />);
    const editable = screen.getByRole("textbox", {
      name: "Markdown document rich text",
    });
    Object.defineProperty(editable, "isContentEditable", { value: true });
    await waitFor(() => expect(editable.hasAttribute("data-empty")).toBe(true));
    expect(editable.style.getPropertyValue("--editor-placeholder")).toBe(
      '"Write a thought…"',
    );
    // The hint is never text inside the editable, so native input cannot keep or save it.
    expect(editable.textContent).not.toContain("Write a thought");
    editable.focus();
    fireEvent(
      editable,
      createEvent.paste(editable, {
        clipboardData: { getData: () => "Checkout idea for retries\n" },
      }),
    );
    await waitFor(() =>
      expect(editable.textContent).toContain("Checkout idea for retries"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(editable.hasAttribute("data-empty")).toBe(false);
  });
  it("hides the placeholder beside content that has no text (K10)", async () => {
    const view = render(
      <MarkdownEditor
        value="---"
        onChange={vi.fn()}
        placeholder="Write a thought…"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.container.querySelector("[data-empty]")).toBeNull();
  });
});
