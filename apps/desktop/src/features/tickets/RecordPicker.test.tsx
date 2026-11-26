// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DocumentPicker } from "./DocumentPicker";
import { RecordPicker } from "./RecordPicker";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

test("refreshing the same query hides stale choices and waits for the new result", async () => {
  const match = {
    groups: [
      { records: [{ kind: "project" as const, key: "p1", title: "API" }] },
    ],
  };
  let finish!: (result: typeof match) => void;
  const search = vi
    .fn()
    .mockResolvedValueOnce({ groups: [] })
    .mockResolvedValueOnce(match)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const onPick = vi.fn();
  const picker = (revision: number) => (
    <RecordPicker
      things="Projects"
      revision={revision}
      search={search}
      onPick={onPick}
    />
  );
  const { rerender } = render(picker(0));
  await screen.findByText("No Projects yet");
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "API" } });
  await screen.findByRole("option", { name: "API" });

  rerender(picker(1));
  expect(screen.getByRole("status").textContent).toBe("Searching…");
  expect(screen.queryByRole("option", { name: "API" })).toBeNull();
  expect(screen.queryByText("No Projects match “API”")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onPick).not.toHaveBeenCalled();

  await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
  await act(async () => finish(match));
  fireEvent.click(await screen.findByRole("option", { name: "API" }));
  expect(onPick).toHaveBeenCalledWith(match.groups[0]?.records[0]);
  expect(screen.queryByRole("status")).toBeNull();
});

test("a failed Document search reports the failure and reserves empty copy for a later successful search", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "recent_documents")
      return [{ id: "doc", heading: "Proposal" }];
    if (
      command === "search_documents" &&
      Reflect.get(args ?? {}, "query") === "P"
    )
      throw { code: "failed", message: "Read failed" };
    return [];
  });
  render(<DocumentPicker onPick={vi.fn()} />);
  await screen.findByRole("option", { name: "Proposal" });

  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "P" } });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't search Documents",
  );
  expect(screen.queryByRole("option", { name: "Proposal" })).toBeNull();
  expect(screen.queryByText("No Documents match “P”")).toBeNull();

  fireEvent.change(input, { target: { value: "Missing" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(await screen.findByText("No Documents match “Missing”")).toBeTruthy();
});
