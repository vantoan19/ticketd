// @vitest-environment jsdom
import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Project } from "@/lib/api/client";
import type { Effort } from "@/lib/api/efforts";
import { CreateTicketDialog } from "./CreateTicketDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
    readOnly,
    "aria-label": label,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly: boolean;
    "aria-label": string;
  }) => (
    <textarea
      aria-label={label}
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(cleanup);

function Harness({
  create,
  navigation = { project: "all", effort: "" },
  projects = [],
  efforts = [],
}: {
  create: (
    title: string,
    body: string,
    status: string,
    project: string | null,
    effort: string | null,
    tags: string[],
    keepOpen: boolean,
  ) => Promise<string>;
  navigation?: { project: string; effort: string };
  projects?: Project[];
  efforts?: Effort[];
}) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        New ticket
      </button>
      <CreateTicketDialog
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        navigation={navigation}
        projects={projects}
        efforts={efforts}
        create={create}
      />
    </>
  );
}

test("editor modes and keyboard operations never create a ticket; explicit submission retains a failed description draft", async () => {
  const create = vi.fn().mockRejectedValue(new Error("Disk full"));
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Draft ticket" },
  });
  expect(
    await screen.findByRole(
      "textbox",
      { name: "Description rich text" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const source = screen.getByRole("textbox", { name: "Description source" });
  fireEvent.change(source, { target: { value: "# Draft\n\n- [ ] Keep this" } });
  fireEvent.keyDown(source, { key: "Enter", ctrlKey: true });
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Disk full"),
  );
  expect(create).toHaveBeenCalledWith(
    "Draft ticket",
    "# Draft\n\n- [ ] Keep this",
    "Todo",
    null,
    null,
    [],
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close new ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }),
  ).toHaveProperty("value", "# Draft\n\n- [ ] Keep this");
  expect(screen.getByText(/Draft restored/)).toBeTruthy();
});

test("creating without a title shows an inline error, keeps focus, and creates nothing", () => {
  const create = vi.fn();
  render(<Harness create={create} />);
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(screen.getByText("Enter a title")).toBeTruthy();
  expect(title.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(title);
  expect(create).not.toHaveBeenCalled();
});

test("opening from a project scope preselects that project", () => {
  render(
    <Harness
      create={vi.fn()}
      navigation={{ project: "p", effort: "" }}
      projects={[{ id: "p", name: "Desktop app", path: "/w", paths: ["/w"] }]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Project: Desktop app" }),
  ).toBeTruthy();
});

test("Ctrl+Enter in the title creates the ticket", async () => {
  const create = vi.fn().mockResolvedValue("T-1");
  render(<Harness create={create} />);
  const title = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Quick" } });
  fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});

test("Create more keeps the dialog open, clears text, keeps properties, refocuses Title, and announces the reference", async () => {
  const create = vi
    .fn()
    .mockResolvedValueOnce("T-1")
    .mockResolvedValueOnce("T-2");
  render(
    <Harness
      create={create}
      navigation={{ project: "all", effort: "e1" }}
      efforts={[{ id: "e1", name: "Sprint 1", archived: false }]}
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Create more" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "First" } });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(screen.getByText("Created T-1")).toBeTruthy());
  expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
  expect(title).toHaveProperty("value", "");
  expect(document.activeElement).toBe(title);
  expect(screen.getByRole("button", { name: "Effort: Sprint 1" })).toBeTruthy();
  fireEvent.change(title, { target: { value: "Second" } });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls.map((call) => [call[0], call[4], call[6]])).toEqual([
    ["First", "e1", true],
    ["Second", "e1", true],
  ]);
});

test("tags are chips that can be added and removed", () => {
  render(<Harness create={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "Add tag" });
  fireEvent.change(input, { target: { value: "Bug" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("bug")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove tag bug" }));
  expect(screen.queryByText("bug")).toBeNull();
});
