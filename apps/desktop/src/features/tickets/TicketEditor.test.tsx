// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { test, vi, expect, afterEach } from "vitest";
import { TicketEditor } from "@/features/tickets/TicketEditor";

const mock = vi.hoisted(() => ({ changeTicket: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ client: mock }));
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Markdown source"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

afterEach(cleanup);

const initial = {
  id: "1",
  reference: "T-1",
  title: "First",
  body: "Old",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  effort_id: null,
  availability: "Ready",
  prerequisites: [],
  parent: null,
  children: [],
};
function Harness() {
  const [ticket, setTicket] = useState(initial);
  return <TicketEditor ticket={ticket as never} onSaved={setTicket as never} />;
}
test("a title-only save should not overwrite an externally updated body", async () => {
  vi.useFakeTimers();
  let stored = { ...initial, body: "External agent body" };
  mock.changeTicket.mockImplementation(
    async (_reference: string, patch: object) => {
      stored = { ...stored, ...patch };
      return stored;
    },
  );
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Renamed" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(stored.body).toBe("External agent body");
  expect(mock.changeTicket).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("reads Markdown until editing is requested, preserving links and draft content", () => {
  render(
    <TicketEditor
      ticket={
        {
          ...initial,
          body: "# Hello\n\n[Read more](https://example.com)",
        } as never
      }
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
  const link = screen.getByRole("link", { name: "Read more" });
  fireEvent.click(link);
  expect(screen.queryByLabelText("Markdown source")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  expect(screen.getByLabelText("Markdown source")).toHaveProperty(
    "value",
    "# Hello\n\n[Read more](https://example.com)",
  );
});

test("keeps a failed Unicode draft visible while adopting an untouched external title", async () => {
  vi.useFakeTimers();
  mock.changeTicket.mockRejectedValueOnce(new Error("Disk full"));
  const onSaved = vi.fn();
  const { rerender } = render(
    <TicketEditor ticket={initial as never} onSaved={onSaved} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  fireEvent.change(screen.getByLabelText("Markdown source"), {
    target: { value: "# Xin chào\n\nSecond line 🌿" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  expect(screen.getByRole("heading", { name: "Xin chào" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Disk full");
  rerender(
    <TicketEditor
      ticket={{ ...initial, title: "External title" } as never}
      onSaved={onSaved}
    />,
  );
  expect(screen.getByLabelText("Title")).toHaveProperty(
    "value",
    "External title",
  );
  expect(screen.getByText("Second line 🌿")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  vi.useRealTimers();
});
