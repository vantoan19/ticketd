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
import type { PublicationAttempt, Ticket } from "@/lib/api/client";
import { SourceActivityContext } from "./source-activity";
import { TicketProperties } from "./TicketProperties";

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

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "1",
  trashed: false,
  reference: "T-1",
  title: "Escalate the cache bug",
  status: "In progress",
  body: "Cache entries never expire.",
  tags: [],
  project_id: null,
  effort_id: null,
  availability: null,
  parent: null,
  children: [],
  prerequisites: [],
  source: null,
  publication: null,
  ...overrides,
});

const attempt = (
  overrides: Partial<PublicationAttempt> = {},
): PublicationAttempt => ({
  id: "a1",
  reference: "T-1",
  provider: "github",
  destination: "acme/api",
  title: "Escalate the cache bug",
  body: "Cache entries never expire.",
  state: "unresolved",
  started_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  failure: { code: "unavailable", message: "request timed out" },
  issue: null,
  ...overrides,
});

const eligible = {
  reference: "T-1",
  provider: "github",
  provider_name: "GitHub",
  destination: "acme/api",
  destinations: ["acme/api"],
  title: "Escalate the cache bug",
  body: "Cache entries never expire.",
  fingerprint: "00000000000000a1",
  eligibility: { kind: "eligible" },
  attempt: null,
};

/** GitHub as the core reports it: connected, and able to create issues. */
const githubEntry = {
  connector: {
    provider: "github",
    name: "GitHub",
    contract_version: 1,
    capabilities: ["discover", "fetch", "comments", "publish"],
    schema: { fields: [] },
  },
  saved: {
    provider: "github",
    config: { repositories: ["acme/api"] },
    account: "octo",
    saved_at: "2026-02-01T00:00:00Z",
  },
};

/** Answers the bridge by command, rejecting `publish_ticket` when given a failure. */
function bridgeAnswers(
  preview: unknown,
  publish?: { reject: { code: string; message: string } },
) {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_sources") return [githubEntry];
    if (command === "preview_publication") return preview;
    if (command === "publish_ticket") {
      if (publish) throw { ...publish.reject, fields: [] };
      return { attempt: attempt({ state: "succeeded" }), replayed: false };
    }
    return [];
  });
}

function rail(value: Ticket, refresh = vi.fn(async () => {})) {
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

test("an eligible local ticket previews the exact issue, then publishes it", async () => {
  bridgeAnswers(eligible);
  const refresh = rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: /Publish T-1 to GitHub/,
  });
  await within(dialog).findByText("Escalate the cache bug");
  expect(
    within(dialog).getByLabelText("Description as it will be sent").textContent,
  ).toBe("Cache entries never expire.");
  expect(within(dialog).getByText("acme/api")).toBeTruthy();
  expect(
    within(dialog).getByText(/no notes, Efforts, dependencies, subtickets/),
  ).toBeTruthy();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Publish to acme/api" }),
  );

  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("publish_ticket", {
      reference: "T-1",
      provider: "github",
      destination: "acme/api",
      expectedFingerprint: "00000000000000a1",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("an ineligible ticket says why and offers no Publish action", async () => {
  bridgeAnswers({
    ...eligible,
    eligibility: {
      kind: "ineligible",
      reason: "status",
      message: "T-1 is Done; only Todo, In progress and In review",
    },
  });
  rail(ticket({ status: "Done" }));
  // The core's own sentence states the rule; the rail adds none of its own.
  await screen.findByText(/T-1 is Done; only Todo, In progress and In review/);
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
});

test("a trashed ticket's rail says why it cannot be published", async () => {
  bridgeAnswers({
    ...eligible,
    eligibility: {
      kind: "ineligible",
      reason: "trashed",
      message: "T-1 is in the trash; restore it to publish it",
    },
  });
  rail(ticket({ trashed: true }));
  await screen.findByText("T-1 is in the trash; restore it to publish it");
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
});

test("a ticket that changed since the preview sends nothing and is previewed again", async () => {
  bridgeAnswers(eligible, {
    reject: {
      code: "publication_changed",
      message: "T-1 changed since it was previewed, so nothing was sent",
    },
  });
  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish to acme/api" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("nothing was sent");
  // The dialog reloads the preview so the person reviews what is there now.
  await waitFor(() =>
    expect(
      bridge.invoke.mock.calls.filter(
        ([command]) => command === "preview_publication",
      ).length,
    ).toBeGreaterThan(2),
  );
});

test("a refusal says nothing was created and allows another try", async () => {
  bridgeAnswers(eligible, {
    reject: {
      code: "publication_failed",
      message:
        "T-1 was not published and remains a local ticket: no permission",
    },
  });
  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish to acme/api" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("no permission");
  expect(alert.textContent).toContain("nothing was created");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Publish to acme/api",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("an unknown outcome blocks retrying and says the issue may exist", async () => {
  bridgeAnswers(eligible, {
    reject: {
      code: "publication_unresolved",
      message: "T-1: GitHub did not answer. The issue may already exist",
    },
  });
  const refresh = rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish to acme/api" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("The outcome is not known");
  expect(alert.textContent).toContain("cannot be published again");
  expect(
    within(dialog).queryByRole("button", { name: /Publish to/ }),
  ).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /Retry/ })).toBeNull();
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

const review = (overrides: Record<string, unknown> = {}) => ({
  attempt: attempt(),
  provider_name: "GitHub",
  known: [
    "ticketd asked GitHub to create “Escalate the cache bug” in acme/api.",
    "The request was sent, but no usable answer came back.",
    "T-1 is still a local ticket with all its progress and organization.",
  ],
  unknown: "whether GitHub created an issue for this attempt.",
  note: "Publishing again is blocked: if the issue exists, creating another would duplicate it.",
  actions: [
    {
      kind: "attach",
      available: true,
      label: "Attach the created issue",
      detail: "Name the issue in acme/api.",
    },
    {
      kind: "not_created",
      available: true,
      label: "Confirm nothing was created",
      detail: "Only when GitHub's recent issues can be read completely.",
    },
  ],
  candidates: [],
  other_recent: [],
  search_ready_at: null,
  candidates_complete: true,
  lookup_failure: null,
  ...overrides,
});

function reviewAnswers(
  value: unknown,
  resolve?: { reject: { code: string; message: string } },
) {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "preview_publication")
      return { ...eligible, attempt: attempt() };
    if (command === "review_publication") return value;
    if (command === "resolve_publication") {
      if (resolve) throw { ...resolve.reject, fields: [] };
      return {
        attempt: attempt({ state: "succeeded" }),
        replayed: false,
      };
    }
    return [];
  });
}

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: /Review details/ }));
  return screen.findByRole("dialog", { name: "Publication unresolved" });
}

test("an unresolved attempt shows the warning and no way to publish blindly", async () => {
  reviewAnswers(review());
  rail(ticket({ publication: attempt() }));
  expect(screen.getByText("Publication unresolved")).toBeTruthy();
  expect(
    screen.getByText(/It may already exist\. Publishing again is blocked/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();

  const dialog = await openReview();
  await within(dialog).findByText("What is known");
  expect(within(dialog).getByText("What is not known")).toBeTruthy();
  expect(
    within(dialog).getByText(/whether GitHub created an issue/),
  ).toBeTruthy();
  expect(
    within(dialog).getByText(/creating another would duplicate/),
  ).toBeTruthy();
  expect(
    within(dialog).queryByRole("button", { name: /Publish to|Retry/ }),
  ).toBeNull();
});

test("naming the created issue attaches it and refreshes the ticket", async () => {
  reviewAnswers(review());
  const refresh = rail(ticket({ publication: attempt() }));
  const dialog = await openReview();
  fireEvent.change(
    await within(dialog).findByLabelText("Issue number or link"),
    {
      target: { value: "12" },
    },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Attach issue" }));

  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("resolve_publication", {
      reference: "T-1",
      resolution: { kind: "attach", issue: "12" },
      acceptDifferentContent: false,
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("evidence the source cannot give keeps the review open and unresolved", async () => {
  reviewAnswers(review(), {
    reject: {
      code: "publication_unverified",
      message:
        "T-1: this could not be verified (provider unreachable). The attempt stays unresolved; nothing was changed",
    },
  });
  const refresh = rail(ticket({ publication: attempt() }));
  const dialog = await openReview();
  fireEvent.click(
    await within(dialog).findByRole("button", {
      name: "Confirm nothing was created",
    }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("stays unresolved");
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("possible matches can be confirmed, and not-created is withheld while they exist", async () => {
  reviewAnswers(
    review({
      candidates: [
        {
          identity: { provider: "github", id: "60" },
          locator: "acme/api#7",
          display: "acme/api#7",
          url: "https://github.example/acme/api/issues/7",
          title: "Escalate the cache bug",
          created_at: "2026-03-01T10:00:00Z",
          reason: "content_match",
        },
      ],
      actions: review().actions.map((action) =>
        action.kind === "not_created"
          ? {
              ...action,
              available: false,
              detail:
                "Not possible: issues that may be this publication already exist.",
            }
          : action,
      ),
    }),
  );
  rail(ticket({ publication: attempt() }));
  const dialog = await openReview();
  await within(dialog).findByText("acme/api#7");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Confirm nothing was created",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // Each "This is it" names the issue it would attach.
  fireEvent.click(
    within(dialog).getByRole("button", { name: "This is acme/api#7" }),
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("resolve_publication", {
      reference: "T-1",
      resolution: { kind: "attach", issue: "acme/api#7" },
      acceptDifferentContent: false,
    }),
  );
});

test("an issue whose text differs is attached only after the person confirms it", async () => {
  const candidate = {
    identity: { provider: "github", id: "61" },
    locator: "acme/api#22",
    display: "acme/api#22",
    url: "https://github.example/acme/api/issues/22",
    title: "Unrelated probe",
    created_at: "2026-03-01T10:00:00Z",
    reason: "created_by_account",
  };
  let confirmed = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "preview_publication")
        return { ...eligible, attempt: attempt() };
      if (command === "review_publication")
        return review({ other_recent: [candidate] });
      if (command === "resolve_publication") {
        if (args?.["acceptDifferentContent"] !== true)
          throw {
            code: "publication_different_content",
            message:
              "T-1: acme/api#22 does not hold what ticketd sent: its title is “Unrelated probe” where ticketd sent “Escalate the cache bug”.",
            fields: [],
          };
        confirmed = true;
        return { attempt: attempt({ state: "succeeded" }), replayed: false };
      }
      return [];
    },
  );
  const refresh = rail(ticket({ publication: attempt() }));
  const dialog = await openReview();
  await within(dialog).findByText(/Created by your account/);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "This is acme/api#22" }),
  );
  await within(dialog).findByText(/does not hold what ticketd sent/);
  expect(confirmed).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Attach anyway" }),
  );
  await waitFor(() => expect(confirmed).toBe(true));
});

test("a failed search is reported and never shown as nothing found", async () => {
  reviewAnswers(
    review({
      candidates_complete: null,
      lookup_failure: { code: "unavailable", message: "provider unreachable" },
    }),
  );
  rail(ticket({ publication: attempt() }));
  const dialog = await openReview();
  const note = await within(dialog).findByText(/could not be searched/);
  expect(note.textContent).toContain("does not mean nothing was created");
});

test("connecting the source in Settings makes a local ticket publishable without reopening it", async () => {
  let connected = false;
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "preview_publication")
      return connected
        ? eligible
        : {
            ...eligible,
            eligibility: {
              kind: "ineligible",
              reason: "source_not_connected",
              message: "connect GitHub in Settings before publishing",
            },
          };
    return [];
  });
  const view = (entries: unknown[]) => (
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [],
        entries: entries as never,
        intervalSecs: null,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <TicketProperties
        ticket={ticket()}
        projects={[]}
        efforts={[]}
        onSaved={() => {}}
        refresh={async () => {}}
      />
    </SourceActivityContext.Provider>
  );
  const { rerender } = render(view([{ ...githubEntry, saved: null }]));
  // Not connected: the rail says why, and offers nothing.
  await screen.findByText("connect GitHub in Settings before publishing");
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
  // The person connects the source and returns: the same ticket now shows Publish.
  connected = true;
  rerender(view([githubEntry]));
  await screen.findByRole("button", { name: /Publish to GitHub/ });
});
