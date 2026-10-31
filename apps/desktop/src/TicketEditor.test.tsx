// @vitest-environment jsdom

import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { test, vi, expect } from "vitest";
import { TicketEditor } from "./TicketEditor";

const mock = vi.hoisted(() => ({ changeTicket: vi.fn() }));
vi.mock("./client", () => ({ client: mock }));
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));
vi.mock("react-markdown", () => ({ default: () => null }));

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
