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
import { SourceFilter } from "./SourceFilter";
import { TicketDetails } from "./TicketDetails";
import { TicketList } from "./TicketList";
import { TicketProperties } from "./TicketProperties";
import { freshness, sourceLocation, sourceState } from "./ticket-source";
import { rowContext } from "./ticket-row";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  ...opener,
  revealItemInDir: vi.fn(),
}));
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  opener.openUrl.mockClear();
});

const source = (overrides: Partial<TicketSource> = {}): TicketSource => ({
  provider: "github",
  id: "42",
  locator: "acme/api#98",
  display: "acme/api#98",
  url: "https://github.com/acme/api/issues/98",
  origin: "imported",
  ownership: "external",
  state: { state: "open" },
  closure_unrecognized: false,
  last_refreshed_at: "2026-02-01T00:00:00Z",
  last_attempt_at: "2026-02-01T00:00:00Z",
  last_error: null,
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
  effort_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
  source: source(),
  ...overrides,
});

function properties(value: Ticket, refresh = vi.fn(async () => {})) {
  render(
    <TicketProperties
      ticket={value}
      projects={[]}
      efforts={[]}
      onSaved={() => {}}
      refresh={refresh}
    />,
  );
  return refresh;
}

test("an open external ticket offers only local progress and says progress stays local", async () => {
  bridge.invoke.mockResolvedValue([]);
  properties(ticket());
  fireEvent.click(screen.getByRole("combobox", { name: /Status: Todo/ }));
  const options = (await screen.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  expect(options).toEqual(["Todo", "In progress", "In review"]);
  expect(
    screen.getByText(/Progress is kept in ticketd and never sent to GitHub/),
  ).toBeTruthy();
});

test("a closed external ticket locks status and explains why", () => {
  bridge.invoke.mockResolvedValue([]);
  properties(
    ticket({
      status: "Done",
      source: source({
        state: { state: "closed", reason: "completed" },
        status_locked: true,
      }),
    }),
  );
  expect(
    (
      screen.getByRole("combobox", { name: /Status: Done/ }) as HTMLElement
    ).getAttribute("data-disabled"),
  ).not.toBeNull();
  expect(
    screen.getByText(/Reopen it there to return this ticket to Todo/),
  ).toBeTruthy();
});

test("an unrecognized closure is flagged instead of guessed", () => {
  bridge.invoke.mockResolvedValue([]);
  properties(
    ticket({
      source: source({
        state: { state: "closed", reason: "unknown" },
        status_locked: true,
        closure_unrecognized: true,
      }),
    }),
  );
  expect(
    screen.getByText(
      /reason ticketd does not recognize, so its status was not/,
    ),
  ).toBeTruthy();
  expect(screen.getByText(/the reason is not recognized/)).toBeTruthy();
});

test("a closed duplicate names the source's canonical issue or says it is unknown", () => {
  bridge.invoke.mockResolvedValue([]);
  const closed = {
    state: { state: "closed", reason: "duplicate" },
    status_locked: true,
  } as const;
  properties(
    ticket({
      status: "Duplicate",
      source: source({
        ...closed,
        duplicate_target: {
          kind: "external",
          identity: { provider: "github", id: "7" },
          locator: "acme/api#7",
          display: "acme/api#7",
        },
      }),
    }),
  );
  expect(screen.getByText("Duplicate of acme/api#7")).toBeTruthy();
  cleanup();
  properties(
    ticket({
      status: "Duplicate",
      source: source({ ...closed, duplicate_target: { kind: "unknown" } }),
    }),
  );
  expect(screen.getByText(/did not name an accessible original/)).toBeTruthy();
});

test("a resolved canonical issue opens its local ticket, and a loop is not followed", () => {
  bridge.invoke.mockResolvedValue([]);
  const closed = {
    state: { state: "closed", reason: "duplicate" },
    status_locked: true,
  } as const;
  const external = {
    kind: "external",
    identity: { provider: "github", id: "7" },
    locator: "acme/api#7",
    display: "acme/api#7",
  } as const;
  const onOpen = vi.fn();
  render(
    <TicketProperties
      ticket={ticket({
        status: "Duplicate",
        source: source({
          ...closed,
          duplicate_target: { ...external, ticket: "T-9" },
        }),
      })}
      projects={[]}
      efforts={[]}
      onSaved={() => {}}
      refresh={vi.fn(async () => {})}
      onOpenTicket={onOpen}
    />,
  );
  expect(screen.getByText("Duplicate of T-9 (acme/api#7)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open T-9" }));
  expect(onOpen).toHaveBeenCalledWith("T-9");
  const rows = (target: object) =>
    rowContext(
      ticket({
        status: "Duplicate",
        source: source({ ...closed, duplicate_target: target as never }),
      }),
      { showEffort: false, showProject: false, efforts: [], projects: [] },
    );
  expect(rows({ ...external, ticket: "T-9" })).toBe("Duplicate of T-9");
  expect(rows({ ...external, problem: "cycle" })).toBe(
    "Duplicate of acme/api#7",
  );
  expect(rows(external)).toBe("Duplicate of acme/api#7");
});

test("the Source section shows the owner, the state, freshness and refreshes one ticket", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "refresh_sources"
      ? {
          imported: [],
          updated: ["T-1"],
          unchanged: 0,
          failures: [],
          refreshed_at: "2026-02-02T00:00:00Z",
        }
      : [],
  );
  const refresh = properties(ticket());
  const section = screen
    .getByRole("heading", { name: "Source" })
    .closest("section")!;
  expect(
    within(section).getByRole("button", { name: "acme / api #98" }),
  ).toBeTruthy();
  expect(within(section).getByText("Open on GitHub")).toBeTruthy();
  expect(within(section).getByText(/^Synced|Synced/)).toBeTruthy();
  expect(
    within(section).getByText(/GitHub owns the title and description/),
  ).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledWith("refresh_sources", {
    ticket: "T-1",
  });
  fireEvent.click(
    within(section).getByRole("button", { name: "acme / api #98" }),
  );
  await waitFor(() =>
    expect(opener.openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/api/issues/98",
    ),
  );
});

test("a failed refresh keeps the content and says the last attempt failed", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "refresh_sources"
      ? {
          imported: [],
          updated: [],
          unchanged: 0,
          failures: [
            {
              provider: "github",
              reference: "T-1",
              code: "unavailable",
              message: "GitHub is down.",
            },
          ],
          refreshed_at: "2026-02-02T00:00:00Z",
        }
      : [],
  );
  properties(
    ticket({
      source: source({
        last_error: { code: "unavailable", message: "GitHub is down." },
      }),
    }),
  );
  expect(screen.getByText(/The last refresh failed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not refresh: GitHub is down. Saved content is unchanged.",
  );
});

test("a local ticket with retained provenance reads Local and names the issue it was", () => {
  bridge.invoke.mockResolvedValue([]);
  properties(
    ticket({
      source: source({ ownership: "local", content_locked: false }),
    }),
  );
  expect(screen.getByText("Local")).toBeTruthy();
  expect(screen.getByText("was acme/api#98")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});

test("an externally owned description is a read-only source card without editing controls", () => {
  bridge.invoke.mockResolvedValue([]);
  render(
    <TicketDetails
      selected="T-1"
      mention={null}
      expanded={false}
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-1": ticket() }}
      projects={[]}
      efforts={[]}
      revision={0}
      refresh={vi.fn(async () => {})}
      updateTicket={vi.fn()}
    />,
  );
  const card = screen.getByRole("region", {
    name: "Description from GitHub, read-only",
  });
  expect(within(card).getByText("GitHub · Read-only")).toBeTruthy();
  expect(within(card).getByText("Described on GitHub")).toBeTruthy();
  expect(
    within(card).getByRole("button", { name: "Edit on GitHub" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /title/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  expect(screen.getByText("Open on GitHub · #98")).toBeTruthy();
  // The detail header and the rail's Source section both link to the issue.
  expect(
    screen.getAllByRole("button", { name: /acme \/ api #98/ }),
  ).toHaveLength(2);
  expect(screen.getByText(/Notes stay in ticketd/)).toBeTruthy();
});

test("a row shows the owner's pill and a local row shows none", () => {
  render(
    <TicketList
      tickets={[
        ticket(),
        ticket({ id: "2", reference: "T-2", title: "Mine", source: null }),
      ]}
      selected={null}
      onOpen={vi.fn()}
      bulkSelection={[]}
      onToggle={vi.fn()}
      selectable
      scope={{
        showEffort: false,
        showProject: false,
        efforts: [],
        projects: [],
      }}
    />,
  );
  const pills = screen.getAllByTitle(/Owned by GitHub/);
  expect(pills).toHaveLength(1);
  expect(pills[0]?.textContent).toBe("Owned by GitHub GitHub #98");
});

test("the source filter offers All, GitHub and Local with counts and reports the choice", () => {
  const onChange = vi.fn();
  render(
    <SourceFilter
      value="all"
      onChange={onChange}
      counts={{ all: 11, local: 4, providers: { github: 7 } }}
      providers={["github"]}
    />,
  );
  const group = screen.getByRole("group", { name: "Ticket source" });
  expect(
    within(group)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["All11", "GitHub7", "Local4"]);
  expect(
    within(group)
      .getByRole("button", { name: /All/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(within(group).getByRole("button", { name: /GitHub/ }));
  expect(onChange).toHaveBeenCalledWith("github");
});

test("source wording: location, state and freshness", () => {
  expect(sourceLocation(source())).toBe("acme / api #98");
  expect(sourceState(source()).text).toBe("Open on GitHub");
  expect(
    sourceState(source({ state: { state: "closed", reason: "not_planned" } }))
      .text,
  ).toBe("Closed on GitHub as not planned");
  const now = new Date("2026-02-01T00:04:30Z").getTime();
  expect(freshness(source(), now)).toBe("Synced 4 min ago");
  expect(freshness(source({ last_refreshed_at: null }), now)).toBe(
    "Not synced yet",
  );
  expect(
    rowContext(
      ticket({
        status: "Duplicate",
        source: source({ duplicate_target: { kind: "unknown" } }),
      }),
      { showEffort: false, showProject: false, efforts: [], projects: [] },
    ),
  ).toBe("Duplicate; original unknown");
});
