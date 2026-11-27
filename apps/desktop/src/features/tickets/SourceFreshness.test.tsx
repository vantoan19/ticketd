// @vitest-environment jsdom
import { githubSource } from "@/test/source-fixtures";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import type { Ticket, TicketSource } from "@/lib/api/client";
import type { SourceStatus } from "@/lib/api/sources";
import { SourceFilter, SourceRefresh } from "./SourceFilter";
import { SourceUnavailableNotice } from "./SourceUnavailableNotice";
import { TestReads } from "@/lib/workspace-reads/testing";
import { TicketList } from "./TicketList";
import { TicketProperties } from "./TicketProperties";
import { SourceActivityContext, type SourceActivity } from "./source-activity";
import { ago, sourceState, unavailableNotice } from "./ticket-source";

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
});

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const status = (overrides: Partial<SourceStatus> = {}): SourceStatus => ({
  provider: "github",
  last_attempt_at: minutesAgo(1),
  last_refreshed_at: minutesAgo(4),
  error: null,
  failing_since: null,
  retry_after: null,
  unavailable_tickets: 0,
  health: "synced",
  partial_message: null,
  ...overrides,
});

function withActivity(activity: Partial<SourceActivity>, children: ReactNode) {
  return (
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [],
        entries: [githubSource],
        intervalSecs: null,
        openSettings: () => {},
        refreshAll: async () => {},
        ...activity,
      }}
    >
      {children}
    </SourceActivityContext.Provider>
  );
}

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
  state: { category: "open", name: "Open" },
  closure_unrecognized: false,
  last_refreshed_at: minutesAgo(30),
  last_attempt_at: minutesAgo(2),
  last_error: null,
  unavailable: null,
  content_locked: true,
  status_locked: false,
  duplicate_target: null,
  ...overrides,
});
const unavailableSource = (overrides: Partial<TicketSource> = {}) =>
  source({
    last_error: { code: "unavailable", message: "Network is down." },
    unavailable: {
      code: "unavailable",
      message: "Network is down.",
      since: minutesAgo(12),
    },
    ...overrides,
  });
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "1",
  trashed: false,
  reference: "T-KQ1",
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

test("the footer says Synced with a green dot, and nothing before a source exists", () => {
  const { container, rerender } = render(
    withActivity({}, <SourceStatusFooter />),
  );
  expect(container.textContent).toBe("");
  rerender(withActivity({ sources: [status()] }, <SourceStatusFooter />));
  expect(screen.getByText(/GitHub synced/)).toBeTruthy();
  expect(
    container.querySelector('[data-slot="status-dot"][data-tone="positive"]'),
  ).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("the footer's status line opens the source's settings", () => {
  const openSettings = vi.fn();
  render(
    withActivity({ openSettings, sources: [status()] }, <SourceStatusFooter />),
  );
  fireEvent.click(screen.getByRole("button", { name: /GitHub synced/ }));
  expect(openSettings).toHaveBeenCalled();
});

test("unassigned tickets retain their own footer row alongside the default connection", () => {
  const openSettings = vi.fn();
  render(
    withActivity(
      {
        openSettings,
        sources: [
          status({ connection_id: "github" }),
          status({ health: "unavailable", unavailable_tickets: 1 }),
        ],
      },
      <SourceStatusFooter />,
    ),
  );
  const connected = screen.getByRole("button", { name: /GitHub synced/ });
  const unassigned = screen.getByRole("button", { name: /1 source issue/ });
  expect(connected.getAttribute("aria-describedby")).not.toBe(
    unassigned.getAttribute("aria-describedby"),
  );
  fireEvent.click(connected);
  expect(openSettings).toHaveBeenLastCalledWith("github");
  fireEvent.click(unassigned);
  expect(openSettings).toHaveBeenLastCalledWith(undefined);
});

test("the footer reads Refreshing GitHub… without a dot while a refresh runs", () => {
  const { container } = render(
    withActivity(
      { refreshing: true, sources: [status()] },
      <SourceStatusFooter />,
    ),
  );
  expect(screen.getByText("Refreshing GitHub…")).toBeTruthy();
  expect(container.querySelector('[data-slot="status-dot"]')).toBeNull();
});

test("an unavailable source shows the failure, the last good sync and a working Retry", () => {
  const refreshAll = vi.fn(async () => {});
  const { container } = render(
    withActivity(
      {
        refreshAll,
        sources: [
          status({
            health: "unavailable",
            error: { code: "unavailable", message: "Network is down." },
            failing_since: minutesAgo(12),
            unavailable_tickets: 3,
          }),
        ],
      },
      <SourceStatusFooter />,
    ),
  );
  expect(screen.getByText("3 source issues")).toBeTruthy();
  expect(screen.getByText(/GitHub last synced 4 min ago/)).toBeTruthy();
  expect(
    container.querySelector('[data-slot="status-dot"][data-tone="attention"]'),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refreshAll).toHaveBeenCalled();
});

test("the tooltip carries the detail line the collapsed sidebar hides", () => {
  render(
    withActivity(
      {
        sources: [
          status({
            health: "unavailable",
            error: { code: "unavailable", message: "Network is down." },
            failing_since: minutesAgo(12),
            unavailable_tickets: 3,
          }),
        ],
      },
      <SourceStatusFooter />,
    ),
  );
  // Hidden text in the collapsed sidebar: the accessible description keeps it.
  expect(
    screen.getByRole("button", {
      name: /3 source issues/,
      description: "GitHub last synced 4 min ago",
    }),
  ).toBeTruthy();
  expect(screen.queryByTitle(/3 source issues/)).toBeNull();
});

test("a rate limit reads as delayed, not unavailable", () => {
  render(
    withActivity(
      {
        sources: [
          status({
            health: "delayed",
            error: { code: "rate_limited", message: "Retry in 600 seconds." },
          }),
        ],
      },
      <SourceStatusFooter />,
    ),
  );
  expect(screen.getByText("GitHub refresh delayed")).toBeTruthy();
  expect(screen.queryByText("GitHub unavailable")).toBeNull();
});

test("one deleted issue reads partly refreshed, never GitHub unavailable", () => {
  render(
    withActivity(
      { sources: [status({ health: "partial", unavailable_tickets: 1 })] },
      <SourceStatusFooter />,
    ),
  );
  expect(screen.getByText("1 source issue")).toBeTruthy();
  expect(screen.queryByText("GitHub unavailable")).toBeNull();
});

test("the unavailable notice says what failed, since when, that nothing was lost, and retries", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "refresh_sources"
      ? {
          imported: [],
          updated: [],
          unchanged: 0,
          failures: [
            {
              provider: "github",
              reference: "T-KQ1",
              code: "unavailable",
              message: "Network is down.",
            },
          ],
          refreshed_at: "2026-02-02T00:00:00Z",
        }
      : [],
  );
  const refresh = vi.fn(async () => {});
  render(
    <SourceUnavailableNotice
      ticket={ticket({ source: unavailableSource() })}
      refresh={refresh}
    />,
  );
  const notice = screen.getByRole("region", { name: "Source unavailable" });
  expect(within(notice).getByText(/Source unavailable/)).toBeTruthy();
  expect(notice.textContent).toContain(
    "and nothing in ticketd was deleted or completed.",
  );
  expect(notice.querySelector("code")?.textContent).toBe("acme/api#98");
  expect(
    within(notice).getByRole("button", { name: /Take ownership/ }),
  ).toBeTruthy();
  fireEvent.click(within(notice).getByRole("button", { name: "Retry now" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledWith("refresh_sources", {
    ticket: "T-KQ1",
    retry: true,
  });
  // A failed retry does not claim success.
  expect(
    await within(notice).findByText(
      /Still unavailable. ticketd can't reach the service/,
    ),
  ).toBeTruthy();
});

test("no notice while the source is reachable or after ownership left the source", () => {
  const { container } = render(
    <SourceUnavailableNotice ticket={ticket()} refresh={async () => {}} />,
  );
  expect(container.textContent).toBe("");
  expect(
    unavailableNotice(unavailableSource({ ownership: "local" })),
  ).toBeNull();
});

test("the state line and the row carry the orange Source unavailable cue", () => {
  expect(sourceState(unavailableSource())).toEqual({
    text: "Source unavailable",
    tone: "attention",
  });
  const { container } = render(
    <TestReads>
      <TicketList
        tickets={[ticket({ source: unavailableSource() })]}
        selected={null}
        onOpen={vi.fn()}
        bulkSelection={[]}
        onToggle={vi.fn()}
        selectable
        scope={{
          showPlan: false,
          showProject: false,
          plans: [],
          projects: [],
        }}
      />
    </TestReads>,
  );
  const row = screen.getByRole("button", { name: /Imported issue/ });
  expect(within(row).getByText("Source unavailable")).toBeTruthy();
  // It replaces Ready, which would describe possibly outdated content.
  expect(within(row).queryByText("Ready")).toBeNull();
  expect(
    container.querySelector('[data-slot="status-dot"][data-tone="attention"]'),
  ).not.toBeNull();
});

test("the rail shows the unavailable warning and keeps Refresh; a running refresh reads Refreshing GitHub…", () => {
  bridge.invoke.mockResolvedValue([]);
  const { rerender } = render(
    withActivity(
      {},
      <TicketProperties
        ticket={ticket({ source: unavailableSource() })}
        projects={[]}
        plans={[]}
        onSaved={() => {}}
        refresh={async () => {}}
      />,
    ),
  );
  const section = screen
    .getByRole("heading", { name: "Source" })
    .closest("section")!;
  expect(
    within(section).getAllByText(/Unavailable since/).length,
  ).toBeGreaterThan(0);
  expect(
    within(section).getByText(/Nothing in ticketd was deleted or completed/),
  ).toBeTruthy();
  // The notice at the top of the document owns Retry; the rail only says so.
  expect(within(section).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(section.querySelectorAll('[data-slot="status-dot"]')).toHaveLength(1);
  expect(within(section).queryByText(/Edit them there/)).toBeNull();
  rerender(
    withActivity(
      { refreshing: true },
      <TicketProperties
        ticket={ticket()}
        projects={[]}
        plans={[]}
        onSaved={() => {}}
        refresh={async () => {}}
      />,
    ),
  );
  expect(screen.getByText("Refreshing GitHub…")).toBeTruthy();
});

test("the refreshing footer words the core's current tracked-ticket count", () => {
  render(
    withActivity(
      { refreshing: true, sources: [status({ tracked_tickets: 7 })] },
      <SourceStatusFooter />,
    ),
  );
  expect(screen.getByText("Checking 7 GitHub tickets")).toBeTruthy();
});

test("the list header reads Refreshing GitHub… for a background refresh without announcing it", () => {
  render(
    withActivity(
      { refreshing: true, sources: [status()] },
      <>
        <SourceFilter
          value="all"
          onChange={() => {}}
          counts={null}
          providers={["github"]}
        />
        <SourceRefresh
          providers={["github"]}
          state={{ running: false, report: null, error: "" }}
        />
      </>,
    ),
  );
  // A background run is shown, not announced to screen readers.
  expect(screen.getByText("Refreshing GitHub…")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Refreshing GitHub");
});

test("the list header shows the last sync when idle", () => {
  render(
    withActivity(
      { sources: [status()] },
      <SourceRefresh
        providers={["github"]}
        state={{ running: false, report: null, error: "" }}
      />,
    ),
  );
  expect(screen.getByRole("status").textContent).toBe("");
});

test("the list header says Last synced, never Synced, while the source is unavailable", () => {
  render(
    withActivity(
      { sources: [status({ health: "unavailable" })] },
      <SourceRefresh
        providers={["github"]}
        state={{ running: false, report: null, error: "" }}
      />,
    ),
  );
  expect(screen.getByRole("status").textContent).toBe("");
  expect(screen.queryByText(/^Synced/)).toBeNull();
});

test("a refresh command failure is visible until a newer source attempt supersedes it", async () => {
  const state = {
    running: false,
    report: null,
    error: "workspace is busy",
    errorAt: "2026-02-02T10:00:00Z",
  };
  const { rerender } = render(
    withActivity(
      { sources: [status({ last_attempt_at: "2026-02-02T09:59:00Z" })] },
      <SourceRefresh providers={["github"]} state={state} />,
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "GitHub refresh failed" }),
  );
  expect(await screen.findByText("workspace is busy")).toBeTruthy();
  rerender(
    withActivity(
      { sources: [status({ last_attempt_at: "2026-02-02T10:01:00Z" })] },
      <SourceRefresh providers={["github"]} state={state} />,
    ),
  );
  expect(
    screen.queryByRole("button", { name: "GitHub refresh failed" }),
  ).toBeNull();
  expect(screen.queryByText("workspace is busy")).toBeNull();
});

test("the unavailable notice is worded by the failure, not by the provider's text", () => {
  const worded = (code: string) =>
    unavailableNotice(
      source({
        unavailable: {
          code,
          message: "raw provider text",
          since: minutesAgo(1),
        },
      }),
    )?.detail ?? "";
  expect(worded("not_found")).toMatch(
    /deleted or is not visible to your account/,
  );
  expect(worded("unauthenticated")).toMatch(/GitHub rejected the sign-in/);
  for (const code of [
    "not_found",
    "unauthenticated",
    "forbidden",
    "unavailable",
  ])
    expect(worded(code)).not.toContain("raw provider text");
});

test("a refresh failure about a ticket that was taken over no longer shows", () => {
  const report = {
    imported: [],
    updated: [],
    failures: [
      {
        provider: "github",
        reference: "T-KQ1",
        code: "not_found",
        message: "gone",
      },
    ],
    refreshed_at: "2026-02-02T00:00:00Z",
  } as never;
  const state = { running: false, report, error: "" };
  const { rerender } = render(
    withActivity(
      {},
      <SourceRefresh
        providers={["github"]}
        state={state}
        tickets={[ticket({ source: source() })]}
      />,
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(
    withActivity(
      {},
      <SourceRefresh
        providers={["github"]}
        state={state}
        tickets={[ticket({ source: null })]}
      />,
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("relative times degrade to the raw value only when unreadable", () => {
  const now = Date.parse("2026-02-01T01:00:00Z");
  expect(ago("2026-02-01T00:59:40Z", now)).toBe("just now");
  expect(ago("2026-02-01T00:00:00Z", now)).toBe("1 h ago");
  expect(ago("2026-01-30T00:00:00Z", now)).toBe("2 d ago");
  expect(ago("garbage", now)).toBeNull();
});

test("discovery provenance follows the core's match flag and links to its settings", () => {
  bridge.invoke.mockResolvedValue([]);
  const openSettings = vi.fn();
  render(
    withActivity(
      { openSettings },
      <TicketProperties
        ticket={ticket({ source: source({ discovery_matches: false }) })}
        projects={[]}
        plans={[]}
        onSaved={vi.fn()}
        refresh={async () => {}}
      />,
    ),
  );
  expect(
    screen.getByText(/No longer matches discovery. It keeps syncing/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discovery settings" }));
  expect(openSettings).toHaveBeenCalledOnce();
});

test("a connection that is missing names the page that adds one", () => {
  const notice = unavailableNotice(
    source({
      unavailable: {
        code: "not_configured",
        message: "Not connected on this desktop",
        since: minutesAgo(1),
      },
    }),
  );
  expect(notice?.detail).toContain("in Settings › Ticket sources to refresh");
});
