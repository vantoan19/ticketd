// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Ticket, TicketSource } from "@/lib/api/client";
import { SourceUnavailableNotice } from "./SourceUnavailableNotice";
import { TicketProperties } from "./TicketProperties";
import { describeChange } from "./history-sentence";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
  revealItemInDir: vi.fn(),
}));
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  vi.restoreAllMocks();
});

const source = (overrides: Partial<TicketSource> = {}): TicketSource => ({
  provider: "github",
  provider_name: "GitHub",
  place: "acme/api",
  number: "#98",
  status_choices: ["Todo", "In progress", "In review"],
  id: "42",
  locator: "acme/api#98",
  display: "acme/api#98",
  url: "https://github.com/acme/api/issues/98",
  origin: "imported",
  ownership: "external",
  state: { state: "open" },
  closure_unrecognized: false,
  last_refreshed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  last_attempt_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  last_error: { code: "unavailable", message: "Network is down." },
  unavailable: {
    code: "unavailable",
    message: "Network is down.",
    since: new Date(Date.now() - 12 * 60_000).toISOString(),
  },
  content_locked: true,
  status_locked: false,
  duplicate_target: null,
  ...overrides,
});
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "1",
  trashed: false,
  reference: "T-1",
  title: "Imported issue",
  status: "Todo",
  body: "Described on GitHub",
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
  source: source(),
  ...overrides,
});

test("Take ownership asks first, explains the consequences, then applies once and refreshes", async () => {
  bridge.invoke.mockResolvedValue(ticket());
  const refresh = vi.fn(async () => {});
  render(<SourceUnavailableNotice ticket={ticket()} refresh={refresh} />);
  fireEvent.click(screen.getByRole("button", { name: /Take ownership/ }));
  // Nothing happens until the person confirms.
  expect(bridge.invoke).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  for (const text of [
    /last synced title, description and status/,
    /edit the title, description and status here/,
    /no longer reach this ticket/,
    /stays as provenance/,
    /It never reconnects by itself/,
    /subtickets, dependencies, relationships and activities/i,
  ])
    expect(within(dialog).getByText(text)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(bridge.invoke).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /Take ownership/ }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Take ownership",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
  expect(bridge.invoke).toHaveBeenCalledWith("take_ownership", {
    reference: "T-1",
    requestId: expect.any(String),
  });
});

test("opening the ownership explanation focuses Cancel without scrolling past its heading", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  render(
    <SourceUnavailableNotice ticket={ticket()} refresh={async () => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Take ownership/ }));
  const dialog = screen.getByRole("dialog");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(
    focus.mock.calls.some(
      ([options], index) =>
        focus.mock.contexts[index] === cancel &&
        options?.preventScroll === true,
    ),
  ).toBe(true);
  expect(
    within(dialog).getByRole("heading", { name: "Take ownership of T-1?" }),
  ).toBeTruthy();
});

test("a failed takeover says why and a retry reuses the same request id", async () => {
  bridge.invoke
    .mockRejectedValueOnce("database is locked")
    .mockResolvedValueOnce(ticket());
  const refresh = vi.fn(async () => {});
  render(<SourceUnavailableNotice ticket={ticket()} refresh={refresh} />);
  const confirm = async () => {
    fireEvent.click(screen.getByRole("button", { name: /Take ownership…/ }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Take ownership",
      }),
    );
  };
  await confirm();
  expect(
    await screen.findByText(/Could not take ownership: database is locked/),
  ).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Take ownership",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  const ids = bridge.invoke.mock.calls.map(([, args]) => args.requestId);
  expect(ids[0]).toBe(ids[1]);
});

test("the rail offers Take ownership only while the source is unavailable, and local tickets show provenance only", () => {
  bridge.invoke.mockResolvedValue([]);
  const props = {
    projects: [],
    plans: [],
    onSaved: () => {},
    refresh: async () => {},
  };
  const { rerender } = render(
    <TicketProperties ticket={ticket()} {...props} />,
  );
  const section = () =>
    screen.getByRole("heading", { name: "Source" }).closest("section")!;
  expect(
    within(section()).getByRole("button", { name: /Take ownership/ }),
  ).toBeTruthy();
  rerender(
    <TicketProperties
      ticket={ticket({
        source: source({ unavailable: null, last_error: null }),
      })}
      {...props}
    />,
  );
  expect(
    within(section()).queryByRole("button", { name: /Take ownership/ }),
  ).toBeNull();
  rerender(
    <TicketProperties
      ticket={ticket({
        source: source({
          ownership: "local",
          unavailable: null,
          last_error: null,
          content_locked: false,
        }),
      })}
      {...props}
    />,
  );
  expect(within(section()).getByText("Local")).toBeTruthy();
  expect(
    within(section()).getByText("acme/api#98").closest("small"),
  ).toBeTruthy();
  expect(within(section()).queryByRole("button")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Source unavailable" }),
  ).toBeNull();
});

test("history words the takeover", () => {
  expect(describeChange("ownership", "github", "local")).toBe(
    "Took ownership from GitHub; the ticket is now local",
  );
});
