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
  eligibility: { kind: "eligible" },
  attempt: null,
};

/** Answers the bridge by command, rejecting `publish_ticket` when given a failure. */
function bridgeAnswers(
  preview: unknown,
  publish?: { reject: { code: string; message: string } },
) {
  bridge.invoke.mockImplementation(async (command: string) => {
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
  await screen.findByText(
    /Done, Canceled and Duplicate tickets are not published/,
  );
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
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

test("a ticket with an unresolved attempt shows the warning shell without any retry", async () => {
  bridgeAnswers({ ...eligible, attempt: attempt() });
  rail(ticket({ publication: attempt() }));
  expect(screen.getByText("Publication unresolved")).toBeTruthy();
  expect(
    screen.getByText(/It may already exist\. Publishing again is blocked/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Review details/ }));
  const dialog = await screen.findByRole("dialog", {
    name: "Publication unresolved",
  });
  expect(
    within(dialog).getByText(/titled “Escalate the cache bug”/),
  ).toBeTruthy();
  expect(within(dialog).getByText("What is not known")).toBeTruthy();
  expect(within(dialog).getByText(/request timed out/)).toBeTruthy();
  expect(
    within(dialog).queryByRole("button", { name: /Publish|Retry/ }),
  ).toBeNull();
});
