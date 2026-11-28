// @vitest-environment jsdom
import { githubSource } from "@/test/source-fixtures";
import { SourceActivityContext } from "./source-activity";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  type ConversationEntry,
  type Ticket,
  type TicketSource,
} from "@/lib/api/client";
import { SourceFilter } from "./SourceFilter";
import { SourceDescription } from "./ReadOnlySource";
import { TicketDetails } from "./TicketDetails";
import { TestReads } from "@/lib/workspace-reads/testing";
import { SourcePill, TicketList } from "./TicketList";
import { TicketProperties } from "./TicketProperties";
import { freshness, sourceLocation, sourceState } from "./ticket-source";
import { rowContextItem } from "./ticket-row";

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
  provider_name: "GitHub",
  place: "acme/api",
  place_label: "acme / api",
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

function properties(value: Ticket, refresh = vi.fn(async () => {})) {
  render(
    <TicketProperties
      ticket={value}
      projects={[]}
      plans={[]}
      onSaved={() => {}}
      refresh={refresh}
    />,
  );
  return refresh;
}

function DetailsFixture({ value }: { value: Ticket }) {
  return (
    // A new value is a new record in a fresh cache, as if re-read.
    <TestReads key={JSON.stringify(value)} primed={{ ticket: value }}>
      <TicketDetails
        selected={value.reference}
        mention={null}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        setSelected={vi.fn()}
        opened={[value.reference]}
        onMentionReady={vi.fn()}
        onClearMention={vi.fn()}
        projects={[]}
        plans={[]}
      />
    </TestReads>
  );
}

test("an open external ticket offers only local progress and says progress stays local", async () => {
  bridge.invoke.mockResolvedValue([]);
  properties(ticket());
  fireEvent.click(screen.getByRole("combobox", { name: /Status: Todo/ }));
  const options = (await screen.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  expect(options).toEqual([
    "Todo",
    "In progress",
    "In review",
    "Done",
    "Canceled",
    "Duplicate",
  ]);
  expect(
    screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-disabled") === "true")
      .map((option) => option.textContent),
  ).toEqual(["Done", "Canceled", "Duplicate"]);
  expect(screen.getByText("Set by GitHub when the issue closes")).toBeTruthy();
  expect(
    screen.getByText(
      /Your progress, kept in ticketd. GitHub controls when the issue closes/,
    ),
  ).toBeTruthy();
});

test("a long source identity keeps its number separate and exposes the complete issue address", async () => {
  bridge.invoke.mockResolvedValue([]);
  const place = "a-long-organization/a-long-repository";
  properties(
    ticket({
      source: source({ place, number: "#12345", display: `${place}#12345` }),
    }),
  );
  const rail = screen.getByRole("region", { name: "Source" });
  const link = within(rail).getByRole("link", { name: `${place}#12345` });
  fireEvent.pointerMove(link);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    `${place}#12345`,
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(within(link).getByText("#12345").textContent).toBe("#12345");
  expect(link.getAttribute("href")).toBe(
    "https://github.com/acme/api/issues/98",
  );
});

test("a closed external ticket locks status and explains why", () => {
  bridge.invoke.mockResolvedValue([]);
  properties(
    ticket({
      status: "Done",
      source: source({
        state: { category: "completed", name: "Closed" },
        status_locked: true,
      }),
    }),
  );
  expect(
    (
      screen.getByRole("combobox", { name: /Status: Done/ }) as HTMLElement
    ).getAttribute("data-disabled"),
  ).toBeNull();
  expect(
    screen.getByText(/Reopen it there to return this ticket to Todo/),
  ).toBeTruthy();
});

test("an unrecognized closure is flagged instead of guessed", async () => {
  bridge.invoke.mockResolvedValue([]);
  properties(
    ticket({
      source: source({
        state: { category: "unknown", name: "Closed" },
        status_locked: false,
        status_choices: ["Done", "Canceled"],
        closure_unrecognized: true,
      }),
    }),
  );
  expect(
    screen.getByText(/GitHub reported an unrecognized state/),
  ).toBeTruthy();
  expect(screen.queryByText("Agent: github")).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Status: Todo" }));
  expect(
    await screen.findByText(
      "Choose Done or Canceled here, or check the issue on GitHub.",
    ),
  ).toBeTruthy();
  expect(
    screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-disabled") !== "true")
      .map((option) => option.textContent),
  ).toEqual(["Done", "Canceled"]);
});

test("a closed duplicate names the source's canonical issue or says it is unknown", () => {
  bridge.invoke.mockResolvedValue([]);
  const closed = {
    state: { category: "duplicate", name: "Closed" },
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
  expect(screen.queryByText(/original unknown/)).toBeNull();
});

test("a resolved canonical issue opens its local ticket, and a loop is not followed", () => {
  bridge.invoke.mockResolvedValue([]);
  const closed = {
    state: { category: "duplicate", name: "Closed" },
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
          duplicate_target: { ...external, ticket: "T-KQ9" },
        }),
      })}
      projects={[]}
      plans={[]}
      onSaved={() => {}}
      refresh={vi.fn(async () => {})}
      onOpenTicket={onOpen}
    />,
  );
  expect(screen.getByText(/^Duplicate of T-KQ9 \(acme\/api#7\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open T-KQ9" }));
  expect(onOpen).toHaveBeenCalledWith("T-KQ9");
  const rows = (target: object) =>
    rowContextItem(
      ticket({
        status: "Duplicate",
        source: source({ ...closed, duplicate_target: target as never }),
      }),
      { showPlan: false, showProject: false, plans: [], projects: [] },
    )?.label ?? null;
  expect(rows({ ...external, ticket: "T-KQ9" })).toBe("Duplicate of T-KQ9");
  expect(rows({ ...external, problem: "cycle" })).toBe(
    "Duplicate of acme/api#7",
  );
  expect(rows(external)).toBe("Duplicate of acme/api#7");
});

test("the Source section shows the owner, the state, freshness and refreshes one ticket", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "latest_update"
      ? null
      : command === "refresh_sources"
        ? {
            imported: [],
            updated: ["T-KQ1"],
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
    within(section).getByRole("link", { name: "acme/api#98" }),
  ).toBeTruthy();
  expect(within(section).queryByText("GitHub: Open")).toBeNull();
  expect(within(section).getByText(/^Synced|Synced/)).toBeTruthy();
  expect(
    within(section).getByText(
      /GitHub owns the title, description and comments/,
    ),
  ).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledWith("refresh_sources", {
    ticket: "T-KQ1",
  });
  fireEvent.click(within(section).getByRole("link", { name: "acme/api#98" }));
  await waitFor(() =>
    expect(opener.openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/api/issues/98",
    ),
  );
});

test("a failed refresh keeps the content and says the last attempt failed", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "latest_update"
      ? null
      : command === "refresh_sources"
        ? {
            imported: [],
            updated: [],
            unchanged: 0,
            failures: [
              {
                provider: "github",
                reference: "T-KQ1",
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
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't refresh T-KQ1. ticketd can't reach the service. Check the connection. Saved content is unchanged.",
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
  expect(screen.getByText("acme/api#98").closest("small")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});

test("an externally owned description is a read-only source card without editing controls", () => {
  bridge.invoke.mockResolvedValue([]);
  render(<DetailsFixture value={ticket()} />);
  const card = screen.getByRole("region", {
    name: "Description from GitHub, read-only",
  });
  expect(within(card).getByText("Read-only")).toBeTruthy();
  expect(within(card).getByText("Described on GitHub")).toBeTruthy();
  expect(
    within(card).getByRole("link", { name: "Edit on GitHub" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /title/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  expect(screen.getAllByText("GitHub issue")).toHaveLength(1);
  expect(within(card).getByText("Open")).toBeTruthy();
  expect(screen.getAllByText("Open")).toHaveLength(1);
  expect(screen.queryByText("GitHub: Open")).toBeNull();
  expect(
    screen.getByRole("link", { name: /acme.*api.*#98/ }).getAttribute("href"),
  ).toBe("https://github.com/acme/api/issues/98");
  fireEvent.click(screen.getByRole("button", { name: ticket().title }));
  expect(screen.getByText("GitHub owns this title.")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(within(card).getByText("Described on GitHub"));
  expect(screen.getByText("GitHub owns this description.")).toBeTruthy();
});

test.each([3, 4])(
  "a GitHub conversation with %i comments keeps its source order when read",
  async (count) => {
    const comments: ConversationEntry[] = Array.from(
      { length: count },
      (_, index) => ({
        type: "comment",
        id: String(index + 1),
        author: "alice",
        body: `Comment ${index + 1} body`,
        url: `https://github.com/acme/api/issues/98#issuecomment-${index + 1}`,
        created_at: `2026-01-0${index + 1}T00:00:00Z`,
        edited_at: null,
      }),
    );
    const assigned: ConversationEntry = {
      type: "event",
      id: "assigned",
      event: "assigned",
      actor: "bob",
      subject: "carol",
      created_at: "2026-01-02T12:00:00Z",
    };
    bridge.invoke.mockImplementation(async (command: string) =>
      command === "source_conversation"
        ? [...comments.slice(0, 2), assigned, ...comments.slice(2)]
        : [],
    );
    render(<DetailsFixture value={ticket()} />);
    const conversation = within(
      await screen.findByRole("region", { name: "Conversation on GitHub" }),
    );
    await conversation.findByRole("heading", {
      name: `GitHub conversation ${count}`,
    });
    expect(conversation.getByText("Comment 1 body")).toBeTruthy();
    expect(conversation.getByText(`Comment ${count} body`)).toBeTruthy();
    expect(conversation.getByText(/assigned carol on GitHub/)).toBeTruthy();

    if (count === 4) {
      expect(conversation.queryByText("Comment 2 body")).toBeNull();
      expect(conversation.queryByText("Comment 3 body")).toBeNull();
      const fold = conversation.getByRole("button", {
        name: "2 more comments",
        expanded: false,
      });
      fireEvent.click(fold);
      expect(
        conversation.getByRole("button", {
          name: "2 more comments",
          expanded: true,
        }),
      ).toBe(fold);
    } else {
      expect(
        conversation.queryByRole("button", { name: /more comments/ }),
      ).toBeNull();
    }

    const second = conversation.getByText("Comment 2 body");
    const third = conversation.getByText("Comment 3 body");
    const assignedText = conversation.getByText(/assigned carol on GitHub/);
    expect(
      second.compareDocumentPosition(assignedText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      assignedText.compareDocumentPosition(third) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  },
);

test.each([
  {
    owner: "GitHub",
    ticketSource: source(),
    prompt: "Write an update · not posted to GitHub",
  },
  { owner: "Local", ticketSource: null, prompt: "Write an update…" },
])(
  "$owner ticket shows where an Activity update goes in the composer",
  async ({ ticketSource, prompt }) => {
    bridge.invoke.mockImplementation(async (command: string) =>
      command === "activity_feed"
        ? [
            {
              type: "authored",
              activity: {
                id: "existing",
                ticket_id: "1",
                brief: "An existing update",
                reported_at: "2026-01-04T00:00:00Z",
                updated_at: "2026-01-04T00:00:00Z",
                editing_agent: null,
                supporting_document_id: null,
              },
            },
          ]
        : [],
    );
    render(<DetailsFixture value={ticket({ source: ticketSource })} />);
    await screen.findByText("An existing update");
    const activity = within(screen.getByRole("region", { name: "Activity" }));
    fireEvent.click(activity.getByRole("button", { name: prompt }));
    const editor = await activity.findByRole("textbox", {
      name: "New update rich text",
    });
    expect(editor.getAttribute("aria-placeholder")).toBe(prompt);
  },
);

test("the source description names who opened the issue and when", () => {
  bridge.invoke.mockResolvedValue([]);
  const openedAt = "2026-02-01T15:00:00Z";
  render(
    <DetailsFixture
      value={ticket({
        source: source({ author: "alice", created_at: openedAt }),
      })}
    />,
  );
  const card = screen.getByRole("region", {
    name: "Description from GitHub, read-only",
  });
  expect(card.textContent).toContain("opened ");
  expect(card.textContent).toContain(" by alice");
  expect(
    within(card)
      .getByText(
        new Date(openedAt).toLocaleDateString(undefined, {
          dateStyle: "medium",
        }),
      )
      .getAttribute("datetime"),
  ).toBe(openedAt);
});

test("a description without original author data still shows the source state", () => {
  bridge.invoke.mockResolvedValue([]);
  render(<DetailsFixture value={ticket()} />);
  const card = screen.getByRole("region", {
    name: "Description from GitHub, read-only",
  });
  expect(within(card).getByText("Open")).toBeTruthy();
  expect(card.textContent).not.toContain("opened");
});

test("an unavailable issue shows its last synced author and opening date", () => {
  bridge.invoke.mockResolvedValue([]);
  const openedAt = "2026-02-01T15:00:00Z";
  render(
    <DetailsFixture
      value={ticket({
        source: source({
          author: "alice",
          created_at: openedAt,
          unavailable: {
            code: "unavailable",
            message: "down",
            since: openedAt,
          },
        }),
      })}
    />,
  );
  const card = screen.getByRole("region", {
    name: "Description from GitHub, read-only",
  });
  expect(within(card).getByText("Source unavailable")).toBeTruthy();
  expect(card.textContent).toContain(" by alice");
  expect(
    within(card)
      .getByText(
        new Date(openedAt).toLocaleDateString(undefined, {
          dateStyle: "medium",
        }),
      )
      .getAttribute("datetime"),
  ).toBe(openedAt);
});

test("an externally completed issue shows its closure time above its description", () => {
  bridge.invoke.mockResolvedValue([]);
  const closedAt = new Date(Date.now() - 210 * 60_000).toISOString();
  render(
    <DetailsFixture
      value={ticket({
        status: "Done",
        source: source({
          state: { category: "completed", name: "Closed" },
          closed_at: closedAt,
          status_locked: true,
        }),
      })}
    />,
  );
  const card = screen.getByRole("region", {
    name: "Description from GitHub, read-only",
  });
  expect(within(card).getByText("Closed (completed)")).toBeTruthy();
  const time = screen.getByText("3 h ago");
  expect(time.getAttribute("datetime")).toBe(closedAt);
  expect(
    time.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("a row shows the owner's pill and a local row shows none", () => {
  render(
    <TestReads>
      <TicketList
        tickets={[
          ticket(),
          ticket({ id: "2", reference: "T-KQ2", title: "Mine", source: null }),
        ]}
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
  const pills = [
    ...document.querySelectorAll('[data-slot="badge"][data-variant="source"]'),
  ] as HTMLElement[];
  expect(pills).toHaveLength(1);
  // Read once: the visible words are hidden from assistive technology and the
  // screen-reader text says the same thing in one sentence.
  expect(within(pills[0]!).getByText("Owned by GitHub, #98")).toBeTruthy();
  expect(pills[0]?.querySelector("span[aria-hidden]")?.textContent).toBe("#98");
});

test("a tracker identifier with a team prefix stays readable in the header and list", () => {
  const issue = ticket({
    source: source({
      provider: "linear",
      provider_name: "Linear",
      place: "ENG",
      place_label: "ENG",
      number: "-42",
      locator: "ENG-42",
      display: "ENG-42",
      url: "https://linear.app/example/issue/ENG-42",
      state: { category: "open", name: "In Progress" },
    }),
  });
  render(
    <>
      <DetailsFixture value={issue} />
      <SourcePill ticket={issue} />
    </>,
  );
  expect(
    screen.getByRole("link", { name: "Open on Linear: ENG-42" }),
  ).toBeTruthy();
  const description = screen.getByRole("region", {
    name: "Description from Linear, read-only",
  });
  expect(within(description).getByText("In Progress")).toBeTruthy();
  expect(screen.getByText("Owned by Linear, ENG-42")).toBeTruthy();
});

test("the source filter offers All, GitHub and Local with counts and reports the choice", () => {
  const onChange = vi.fn();
  render(
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [],
        entries: [githubSource],
        intervalSecs: null,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SourceFilter
        value="all"
        onChange={onChange}
        counts={{ all: 11, local: 4, providers: { github: 7 } }}
        providers={["github"]}
      />
    </SourceActivityContext.Provider>,
  );
  const group = screen.getByRole("radiogroup", { name: "Ticket source" });
  expect(
    within(group)
      .getAllByRole("radio")
      .map((radio) => radio.textContent),
  ).toEqual(["All 11", "GitHub 7", "Local 4"]);
  expect(
    within(group)
      .getByRole("radio", { name: /All/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(within(group).getByRole("radio", { name: /GitHub/ }));
  expect(onChange).toHaveBeenCalledWith("github");
});

test("source wording: location, state and freshness", () => {
  expect(sourceLocation(source())).toBe("acme / api #98");
  expect(sourceState(source()).text).toBe("Open");
  expect(
    sourceState(source({ state: { category: "not_planned", name: "Closed" } }))
      .text,
  ).toBe("Closed (not planned)");
  expect(
    sourceState(
      source({
        provider_name: "Tracker",
        state: { category: "open", name: "In development" },
      }),
    ),
  ).toEqual({ text: "In development", tone: "positive" });
  const now = new Date("2026-02-01T00:04:30Z").getTime();
  expect(freshness(source(), now)).toBe("Synced 4 min ago");
  expect(freshness(source({ last_refreshed_at: null }), now)).toBe(
    "Not synced yet",
  );
  expect(
    rowContextItem(
      ticket({
        status: "Duplicate",
        source: source({ duplicate_target: { kind: "unknown" } }),
      }),
      { showPlan: false, showProject: false, plans: [], projects: [] },
    )?.label,
  ).toBe("Duplicate · target unknown");
});

test("a local child explains its independent ownership when its parent belongs to GitHub", async () => {
  // GitHub is set up, so the rail has a Source section saying "Local".
  const github = {
    connector: {
      provider: "github",
      name: "GitHub",
      contract_version: 1,
      capabilities: [],
      schema: { fields: [] },
    },
    saved: {
      provider: "github",
      config: {},
      account: "octo",
      saved_at: "2026-01-01T00:00:00Z",
    },
  };
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "show_ticket"
      ? ticket({ reference: "T-KQ2" })
      : command === "list_sources"
        ? [github]
        : [],
  );
  properties(
    ticket({
      source: null,
      parent: { reference: "T-KQ2", title: "Parent", trashed: false },
    }),
  );
  expect(await screen.findByText("Local")).toBeTruthy();
  expect(
    await screen.findByText(
      /belongs to GitHub; this ticket stays local unless you publish it on its own/,
    ),
  ).toBeTruthy();
});

test("a long source description opens its named fold without making the field editable", () => {
  render(
    <SourceDescription
      ticket={ticket({
        body: [
          "Starting context. ".repeat(56),
          "## Scope",
          "Hidden source detail. ".repeat(100),
          "## Acceptance criteria",
          "- [ ] Verify",
        ].join("\n\n"),
      })}
      source={source()}
      revision={0}
      select={vi.fn()}
    />,
  );
  const fold = screen.getByRole("button", { name: "1 more section: Scope" });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(
    screen.getByRole("heading", { name: "Acceptance criteria" }),
  ).toBeTruthy();
  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("heading", { name: "Scope" })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByText("Verify"));
  expect(screen.getByRole("img", { name: "Not done" })).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "change_ticket",
    expect.anything(),
  );
  fireEvent.click(fold);
});
