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
import type { ConversationEntry, TicketSource } from "@/lib/api/client";
import { SourceConversation } from "./SourceConversation";

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
  last_refreshed_at: "2026-02-01T00:00:00Z",
  last_attempt_at: "2026-02-01T00:00:00Z",
  last_error: null,
  content_locked: true,
  status_locked: false,
  duplicate_target: null,
  ...overrides,
});

const comment = (
  id: string,
  author: string,
  body: string,
  extra: Partial<Extract<ConversationEntry, { type: "comment" }>> = {},
): ConversationEntry => ({
  type: "comment",
  id,
  author,
  body,
  url: `https://github.com/acme/api/issues/98#issuecomment-${id}`,
  created_at: "2026-01-02T00:00:00Z",
  edited_at: null,
  ...extra,
});

const event = (
  id: string,
  kind: string,
  actor: string | null,
  subject: string | null = null,
): ConversationEntry => ({
  type: "event",
  id,
  event: kind,
  actor,
  subject,
  created_at: "2026-01-03T00:00:00Z",
});

function conversation(entries: ConversationEntry[]) {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "source_conversation") return entries;
    throw new Error(`unexpected ${command}`);
  });
}

function view(value: TicketSource, revision = 0) {
  return (
    <SourceConversation
      source={value}
      reference="T-1"
      revision={revision}
      select={() => {}}
    />
  );
}

test("comments and events share one connected timeline in source order, all read-only", async () => {
  conversation([
    comment("501", "alice", "Please **take** a look", {
      edited_at: "2026-01-02T05:00:00Z",
    }),
    event("601", "closed_completed", "bob"),
    event("602", "assigned", "bob", "carol"),
    event("603", "assigned", "dave", "dave"),
    event("604", "unassigned", "bob", "carol"),
    event("605", "closed_duplicate", "bob"),
    event("606", "closed_not_planned", "bob"),
    event("607", "closed", null),
    event("608", "reopened", "bob"),
  ]);
  render(view(source()));

  const card = await screen.findByRole("article", {
    name: /Comment by alice on GitHub, read-only/,
  });
  expect(within(card).getByText("Read-only")).toBeTruthy();
  expect(within(card).getByText("edited")).toBeTruthy();
  expect(within(card).getByText("take").tagName).toBe("STRONG");
  // Nothing in the conversation can be edited, deleted or composed locally.
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /edit|delete|reply/i }),
  ).toBeNull();

  const rows = screen.getAllByRole("listitem");
  const text = rows.map((row) => row.textContent ?? "");
  expect(text[0]).toContain("alice");
  expect(text[1]).toContain("bob closed this as completed");
  expect(text[2]).toContain("bob assigned carol");
  expect(text[3]).toContain("dave self-assigned this");
  expect(text[4]).toContain("bob unassigned carol");
  expect(text[5]).toContain("bob closed this as a duplicate");
  expect(text[6]).toContain("bob closed this as not planned");
  expect(text[7]).toContain("Someone closed this");
  expect(text[8]).toContain("bob reopened this");
});

test("View and Comment link to the source and there is no composer", async () => {
  conversation([comment("501", "alice", "hello")]);
  render(view(source()));
  await screen.findByRole("article");

  fireEvent.click(screen.getByRole("link", { name: "View on GitHub" }));
  expect(opener.openUrl).toHaveBeenCalledWith(
    "https://github.com/acme/api/issues/98#issuecomment-501",
  );
  fireEvent.click(screen.getByRole("link", { name: "Comment on GitHub" }));
  expect(opener.openUrl).toHaveBeenLastCalledWith(
    "https://github.com/acme/api/issues/98",
  );
});

test("an externally owned ticket with no conversation says so and still links to the source", async () => {
  conversation([]);
  render(view(source()));
  expect(await screen.findByText("No comments on GitHub yet.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Comment on GitHub" })).toBeTruthy();
});

test("a ticket whose ownership was taken shows retained entries, or nothing", async () => {
  conversation([]);
  const { container } = render(view(source({ ownership: "local" })));
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
  expect(container.textContent).toBe("");
  cleanup();

  conversation([comment("501", "alice", "kept")]);
  render(view(source({ ownership: "local" })));
  expect(await screen.findByText("kept")).toBeTruthy();
  // Provenance only: it is no longer the source's ticket to comment on.
  expect(
    screen.queryByRole("button", { name: "Comment on GitHub" }),
  ).toBeNull();
});

test("a refresh keeps the cards in place and a failed reload keeps what was retrieved", async () => {
  conversation([comment("501", "alice", "first")]);
  const { rerender } = render(view(source()));
  const card = await screen.findByRole("article");

  conversation([
    comment("501", "alice", "first"),
    comment("502", "bob", "second"),
  ]);
  rerender(view(source({ last_refreshed_at: "2026-02-02T00:00:00Z" })));
  await screen.findByText("second");
  // The same element, so scroll position and selection survive the refresh.
  expect(screen.getAllByRole("article")[0]).toBe(card);

  bridge.invoke.mockRejectedValue("the workspace is busy");
  rerender(view(source({ last_refreshed_at: "2026-02-03T00:00:00Z" })));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "the workspace is busy",
  );
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("second")).toBeTruthy();
});
