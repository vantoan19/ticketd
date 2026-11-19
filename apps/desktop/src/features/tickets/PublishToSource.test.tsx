// @vitest-environment jsdom
import {
  act,
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
import { PublicationNotice, PublishDialog } from "./PublishToSource";
import { publicationReason } from "./use-publication-preview";
import type { PublicationPreview } from "@/lib/api/sources";
import { TicketHeader } from "./TicketHeader";
import { TestReads } from "@/lib/workspace-reads/testing";
import type { ComponentProps } from "react";
import { TicketProperties as Properties } from "./TicketProperties";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";
import { open } from "@tauri-apps/plugin-dialog";

/** The property rail as the Ticket page mounts it, inside the open Ticket. */
function TicketProperties(props: ComponentProps<typeof Properties>) {
  return (
    <OpenTicketFor reference={props.ticket.reference} ticket={props.ticket}>
      <Properties {...props} />
    </OpenTicketFor>
  );
}

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
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
  reference: "T-KQ1",
  title: "Escalate the cache bug",
  status: "In progress",
  body: "Cache entries never expire.",
  tags: [],
  project_id: null,
  plan_id: null,
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
  reference: "T-KQ1",
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
  reference: "T-KQ1",
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
    if (command === "show_ticket") return ticket();
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
      plans={[]}
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
    name: /Publish T-KQ1 to GitHub/,
  });
  await within(dialog).findByText("Escalate the cache bug");
  expect(
    within(dialog).getByLabelText("Description as it will be sent").textContent,
  ).toBe("Cache entries never expire.");
  const repository = within(dialog).getByRole("combobox", {
    name: "Repository",
  });
  expect(repository.textContent).toContain("acme/api");
  expect(repository.getAttribute("data-readonly")).toBe("true");
  expect(
    within(dialog).getByText(/No ticketd labels, fields or comments are added/),
  ).toBeTruthy();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Publish issue" }),
  );

  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("publish_ticket", {
      reference: "T-KQ1",
      provider: "github",
      destination: "acme/api",
      expectedFingerprint: "00000000000000a1",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("Publish stays in place while the preview reads again after an edit", async () => {
  bridgeAnswers(eligible);
  const props = {
    projects: [],
    plans: [],
    onSaved: () => {},
    refresh: async () => {},
  };
  const { rerender } = render(
    <TicketProperties ticket={ticket()} {...props} />,
  );
  await screen.findByRole("button", { name: /Publish to GitHub/ });
  // The next read never answers: the last answer stays, nothing blinks.
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "list_sources"
      ? [githubEntry]
      : command === "preview_publication"
        ? new Promise(() => {})
        : [],
  );
  rerender(
    <TicketProperties ticket={ticket({ title: "Renamed" })} {...props} />,
  );
  expect(
    screen.getByRole("button", { name: /Publish to GitHub/ }),
  ).toBeTruthy();
});

test("workspace links open the core preflight with affected files and no publication action", async () => {
  const message =
    "Workspace-only attachment links cannot be published. Remove or replace links in the description, or export Markdown with files.";
  bridgeAnswers({
    ...eligible,
    internal_attachments: [
      {
        uri: "ticketd://attachment/workspace/file",
        display_name: "Checkout error.png",
      },
    ],
    eligibility: {
      kind: "ineligible",
      reason: "internal_attachments",
      message,
    },
  });
  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Resolve attachment links before publishing",
  });
  expect(within(dialog).getByRole("alert").textContent).toContain(message);
  expect(within(dialog).getByText("Checkout error.png")).toBeTruthy();
  expect(
    within(dialog).getByText(/Direct local attachment associations stay/),
  ).toBeTruthy();
  expect(
    within(dialog).queryByRole("button", { name: "Publish issue" }),
  ).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Review description" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "publish_ticket"),
  ).toBe(false);
});

test("a destination outside the saved list is refused with the core's reason", async () => {
  const message =
    "cannot publish to 'acme/secret-roadmap': this source only publishes to acme/api";
  const refused = {
    ...eligible,
    destination: "acme/secret-roadmap",
    eligibility: {
      kind: "ineligible",
      reason: "destination_not_allowed",
      message,
    },
  };
  expect(publicationReason(refused as PublicationPreview)).toBe(message);
  bridgeAnswers(refused);
  render(
    <PublishDialog
      ticket={ticket()}
      provider="github"
      onOpenChange={() => {}}
      refresh={async () => {}}
    />,
  );
  expect(await screen.findByText(message)).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Publish issue" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("publication preview explains that direct local files are not sent", async () => {
  bridgeAnswers({
    ...eligible,
    local: {
      activities: 0,
      plan: null,
      tags: [],
      subtickets: [],
      attachments: 2,
    },
  });
  render(
    <PublishDialog
      ticket={ticket()}
      provider="github"
      onOpenChange={() => {}}
      refresh={async () => {}}
    />,
  );
  expect(
    await screen.findByText(/2 directly attached files stay/),
  ).toBeTruthy();
});

test("blocked publication exports with files without initiating publication", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "preview_publication")
      return {
        ...eligible,
        internal_attachments: [
          {
            uri: "ticketd://attachment/workspace/file",
            display_name: "trace.log",
          },
        ],
        eligibility: {
          kind: "ineligible",
          reason: "internal_attachments",
          message: "Export with files before sharing.",
        },
      };
    if (command === "export_markdown_with_files")
      return {
        format_version: 1,
        status: "complete",
        directory: "C:/sharing/export",
        markdown_path: "content.md",
        manifest_path: "manifest.json",
        attachments: [],
      };
    return [];
  });
  render(
    <PublishDialog
      ticket={ticket()}
      provider="github"
      onOpenChange={() => {}}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Export with files" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Export complete" }),
  ).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("export_markdown_with_files", {
    source: { kind: "ticket", reference: "T-KQ1" },
    output: "C:/sharing",
  });
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "publish_ticket"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(
    screen.getByRole("dialog", {
      name: "Resolve attachment links before publishing",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Publish issue" })).toBeNull();
});

test("an attachment added after preview refreshes the dialog to the blocked preflight", async () => {
  let submitted = false;
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "preview_publication")
      return submitted
        ? {
            ...eligible,
            internal_attachments: [
              {
                uri: "ticketd://attachment/workspace/new-file",
                display_name: "New trace",
              },
            ],
            eligibility: {
              kind: "ineligible",
              reason: "internal_attachments",
              message: "Remove the new internal link before publishing.",
            },
          }
        : eligible;
    if (command === "publish_ticket") {
      submitted = true;
      throw {
        code: "publication_ineligible",
        message: "Remove the new internal link before publishing.",
      };
    }
    return [];
  });
  render(
    <PublishDialog
      ticket={ticket()}
      provider="github"
      onOpenChange={() => {}}
      refresh={async () => {}}
    />,
  );
  const publish = await screen.findByRole("button", { name: "Publish issue" });
  await waitFor(() =>
    expect((publish as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(publish);
  expect(
    await screen.findByRole("dialog", {
      name: "Resolve attachment links before publishing",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Publish issue" })).toBeNull();
});

test("the publication dialog keeps a Close action and closes without sending", async () => {
  bridgeAnswers(eligible);
  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: /Publish T-KQ1 to GitHub/,
  });
  const close = within(dialog).getByRole("button", { name: "Close" });
  fireEvent.click(close);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "publish_ticket"),
  ).toBe(false);
});

test("changing repositories waits for that destination's preview before publishing", async () => {
  const apiPreview = {
    ...eligible,
    destinations: ["acme/api", "acme/web"],
    fingerprint: "fingerprint-api",
  };
  const webPreview = {
    ...eligible,
    destination: "acme/web",
    destinations: ["acme/api", "acme/web"],
    fingerprint: "fingerprint-web",
  };
  let resolveWebPreview!: (preview: typeof webPreview) => void;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { destination?: string }) => {
      if (command === "list_sources") return [githubEntry];
      if (command === "preview_publication") {
        if (args?.destination === "acme/web")
          return new Promise<typeof webPreview>((resolve) => {
            resolveWebPreview = resolve;
          });
        return apiPreview;
      }
      if (command === "publish_ticket")
        return { attempt: attempt({ state: "succeeded" }), replayed: false };
      return [];
    },
  );

  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: /Publish T-KQ1 to GitHub/,
  });
  const repository = await within(dialog).findByRole("combobox", {
    name: "Repository",
  });
  fireEvent.click(repository);
  fireEvent.click(await screen.findByRole("option", { name: "acme/web" }));

  const publish = within(dialog).getByRole("button", {
    name: "Publish issue",
  }) as HTMLButtonElement;
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "preview_publication",
      expect.objectContaining({ destination: "acme/web" }),
    ),
  );
  expect(publish.disabled).toBe(true);

  await act(async () => {
    resolveWebPreview(webPreview);
  });
  await waitFor(() => expect(publish.disabled).toBe(false));
  fireEvent.click(publish);

  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("publish_ticket", {
      reference: "T-KQ1",
      provider: "github",
      destination: "acme/web",
      expectedFingerprint: "fingerprint-web",
    }),
  );
});

test("an ineligible ticket says why and offers no Publish action", async () => {
  bridgeAnswers({
    ...eligible,
    eligibility: {
      kind: "ineligible",
      reason: "status",
      message: "T-KQ1 is Done; only Todo, In progress and In review",
    },
  });
  rail(ticket({ status: "Done" }));
  // The core's own sentence states the rule; the rail adds none of its own.
  await screen.findByText(
    /Only Todo, In progress and In review tickets can be published/,
  );
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
});

test("a trashed ticket's rail says why it cannot be published", async () => {
  bridgeAnswers({
    ...eligible,
    eligibility: {
      kind: "ineligible",
      reason: "trashed",
      message: "T-KQ1 is in the trash; restore it to publish it",
    },
  });
  rail(ticket({ trashed: true }));
  await screen.findByText(/Restore this ticket from the trash to publish it\./);
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
});

test("a ticket that changed since the preview sends nothing and is previewed again", async () => {
  bridgeAnswers(eligible, {
    reject: {
      code: "publication_changed",
      message: "T-KQ1 changed since it was previewed, so nothing was sent",
    },
  });
  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish issue" }),
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
        "T-KQ1 was not published and remains a local ticket: no permission",
    },
  });
  rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish issue" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).not.toContain("no permission");
  fireEvent.click(within(alert).getByRole("button", { name: "Details" }));
  expect(
    screen.getByText(
      "T-KQ1 was not published and remains a local ticket: no permission",
    ),
  ).toBeTruthy();
  expect(alert.textContent?.toLowerCase()).toContain("nothing was created");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Publish issue",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("an unknown outcome blocks retrying and says the issue may exist", async () => {
  bridgeAnswers(eligible, {
    reject: {
      code: "publication_unresolved",
      message: "T-KQ1: GitHub did not answer. The issue may already exist",
    },
  });
  const refresh = rail(ticket());
  fireEvent.click(
    await screen.findByRole("button", { name: /Publish to GitHub/ }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Publish issue" }),
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
    "T-KQ1 is still a local ticket with all its progress and organization.",
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
  expect(screen.getByText("Publish outcome unknown")).toBeTruthy();
  expect(
    screen.getByText(/Stays Local until the outcome is settled/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();

  const dialog = await openReview();
  await within(dialog).findByText("What is known");
  expect(within(dialog).getByText("What is not known")).toBeTruthy();
  expect(
    within(dialog).getByText(/Whether GitHub created an issue/),
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
      reference: "T-KQ1",
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
        "T-KQ1: this could not be verified (provider unreachable). The attempt stays unresolved; nothing was changed",
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
      reference: "T-KQ1",
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
              "T-KQ1: acme/api#22 does not hold what ticketd sent: its title is “Unrelated probe” where ticketd sent “Escalate the cache bug”.",
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
  await within(dialog).findByText(/has different content/);
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
        plans={[]}
        onSaved={() => {}}
        refresh={async () => {}}
      />
    </SourceActivityContext.Provider>
  );
  const { rerender } = render(view([{ ...githubEntry, saved: null }]));
  // Not set up: no Source section, no "Local", no upsell and no Publish.
  await screen.findByRole("heading", { name: "Tags" });
  expect(screen.queryByRole("heading", { name: "Source" })).toBeNull();
  expect(screen.queryByText("Local")).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
  // The person connects the source and returns: the same ticket now shows Publish.
  connected = true;
  rerender(view([githubEntry]));
  await screen.findByRole("button", { name: /Publish to GitHub/ });
});

test("the inline unresolved panel keeps retry disabled after dismissing a candidate and can check again", async () => {
  const candidate = {
    identity: { provider: "github", id: "99" },
    locator: "acme/api#99",
    display: "acme/api#99",
    url: "https://github.com/acme/api/issues/99",
    title: "Possible result",
    created_at: "2026-02-01T00:00:00Z",
    reason: "content_match",
  };
  const value = review({
    candidates: [candidate],
    actions: [
      { kind: "attach", available: true, label: "Attach", detail: "Name it" },
      {
        kind: "not_created",
        available: false,
        label: "Confirm nothing was created",
        detail: "A matching issue still exists.",
      },
    ],
  });
  reviewAnswers(value);
  render(
    <PublicationNotice
      ticket={ticket({ publication: attempt() })}
      refresh={vi.fn(async () => {})}
    />,
  );
  const panel = screen.getByRole("region", { name: "Publish outcome unknown" });
  expect(
    within(panel).getByRole("heading", {
      level: 3,
      name: "Publish outcome unknown",
    }),
  ).toBeTruthy();
  expect(await within(panel).findByText("Possible result")).toBeTruthy();
  const retry = within(panel).getByRole("button", { name: "Publish again" });
  expect(retry).toHaveProperty("disabled", true);
  fireEvent.click(within(panel).getByRole("button", { name: "Not this one" }));
  expect(within(panel).queryByText("Possible result")).toBeNull();
  expect(retry).toHaveProperty("disabled", true);
  fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
  expect(await within(panel).findByText("Possible result")).toBeTruthy();
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "publish_ticket"),
  ).toBe(false);
});

test("the Actions menu offers publish with the core's disabled reason", async () => {
  bridgeAnswers({
    ...eligible,
    eligibility: {
      kind: "ineligible",
      reason: "status",
      message: "core status refusal",
    },
  });
  render(
    <TestReads>
      <TicketHeader
        selected="T-KQ1"
        ticket={ticket({ status: "Done" })}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        onClose={vi.fn()}
        onOpenGraph={vi.fn()}
      />
    </TestReads>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Ticket actions" }), {
    key: "Enter",
  });
  const item = await screen.findByRole("menuitem", {
    name: /Publish to GitHub/,
  });
  await waitFor(() =>
    expect(item.textContent).toContain(
      "Only Todo, In progress and In review tickets can be published.",
    ),
  );
  expect(item.getAttribute("data-disabled")).not.toBeNull();
});

test("publishing from Actions opens the same exact preview before sending", async () => {
  bridgeAnswers(eligible);
  render(
    <TestReads>
      <TicketHeader
        selected="T-KQ1"
        ticket={ticket()}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        onClose={vi.fn()}
        onOpenGraph={vi.fn()}
      />
    </TestReads>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Ticket actions" }), {
    key: "Enter",
  });
  const item = await screen.findByRole("menuitem", {
    name: "Publish to GitHub…",
  });
  await waitFor(() => expect(item.getAttribute("data-disabled")).toBeNull());
  fireEvent.click(item);
  expect(
    await screen.findByRole("dialog", { name: "Publish T-KQ1 to GitHub" }),
  ).toBeTruthy();
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "publish_ticket"),
  ).toBe(false);
});
