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
afterEach(cleanup);

function Harness({
  create,
}: {
  create: (title: string, body: string) => Promise<void>;
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
        navigation={{ project: "all", effort: "" }}
        projects={[]}
        efforts={[]}
        create={create}
      />
    </>
  );
}

test("editor modes and keyboard operations never create a ticket; explicit submission retains a failed description draft", async () => {
  const create = vi.fn().mockRejectedValue(new Error("Disk full"));
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "New ticket title" }), {
    target: { value: "Draft ticket" },
  });
  expect(
    screen.getByRole("textbox", { name: "Description rich text" }),
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
  );
  fireEvent.click(screen.getByRole("button", { name: "Close new ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }),
  ).toHaveProperty("value", "# Draft\n\n- [ ] Keep this");
});
