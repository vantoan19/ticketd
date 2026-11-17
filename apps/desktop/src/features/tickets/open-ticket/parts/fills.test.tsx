// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthoredActivity } from "@/lib/api/client";
import type { DocumentLink } from "@/features/documents/api";
import { useOpenTicket } from "..";
import {
  editedUpdateFills,
  followingFill,
  relinkedDocumentFill,
  unlinkedDocumentFill,
} from ".";
import { TestOpenTicket } from "../testing";
import { ticketFor } from "./ticket-fixture";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const ticket = ticketFor("T-1");
const busy = { code: "workspace_locked", message: "busy" };

beforeEach(() => {
  bridge.invoke.mockReset();
});
afterEach(cleanup);

// Each test reports a write with the section's fill while the re-read that
// follows fails, so what shows is the fill and nothing else.

it("shows a Follow written by this window until a read answers, through a failed re-read", async () => {
  bridge.invoke.mockResolvedValueOnce(false).mockRejectedValue(busy);
  function Section() {
    const following = useOpenTicket("following");
    const { record, changed } = useOpenTicket();
    return (
      <>
        <output aria-label="following">{String(following.value)}</output>
        <button
          onClick={() =>
            void changed(undefined, [followingFill(record.reference, true)])
          }
        >
          follow
        </button>
      </>
    );
  }
  render(
    <TestOpenTicket ticket={ticket}>
      <Section />
    </TestOpenTicket>,
  );
  await screen.findByText("false");
  await act(async () => screen.getByText("follow").click());
  expect(screen.getByLabelText("following").textContent).toBe("true");
});

const note = (brief: string, id = "u1"): AuthoredActivity => ({
  id,
  ticket_id: ticket.id,
  brief,
  reported_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  editing_agent: null,
});

it("shows an edited update in its linked read and its feed row, through a failed re-read", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [
        { type: "authored", activity: note("old") },
        { type: "authored", activity: note("other", "u2") },
      ];
    if (command === "get_activity") return note("old");
    throw busy;
  });
  function Section() {
    const feed = useOpenTicket("activity");
    const linked = useOpenTicket("activityNote", "u1");
    const { record, changed } = useOpenTicket();
    const rows = (feed.value ?? []).map((item) =>
      item.type === "authored" ? item.activity.brief : "-",
    );
    return (
      <>
        <output aria-label="feed">{rows.join(",")}</output>
        <output aria-label="linked">{linked.value?.brief ?? "none"}</output>
        <button
          onClick={() =>
            void changed(undefined, editedUpdateFills(record, note("new")))
          }
        >
          edit
        </button>
      </>
    );
  }
  render(
    <TestOpenTicket ticket={ticket}>
      <Section />
    </TestOpenTicket>,
  );
  await screen.findByText("old,other");
  await screen.findByText("old");
  bridge.invoke.mockImplementation(async () => {
    throw busy;
  });
  await act(async () => screen.getByText("edit").click());
  expect(screen.getByLabelText("feed").textContent).toBe("new,other");
  expect(screen.getByLabelText("linked").textContent).toBe("new");
});

const link: DocumentLink = {
  source_id: ticket.id,
  target_id: "d1",
  source_kind: "ticket",
  target_kind: "document",
  passage: "",
  source_label: "T-1",
  target_label: "Launch plan",
  source_trashed: false,
  target_trashed: false,
  explicit: true,
};

it("shows a Document unlinked and linked again at once, through failed re-reads", async () => {
  bridge.invoke.mockResolvedValueOnce([[link], []]).mockRejectedValue(busy);
  function Section() {
    const documents = useOpenTicket("documents");
    const { record, changed } = useOpenTicket();
    return (
      <>
        <output aria-label="documents">
          {documents.links?.map((item) => item.target_label).join(",") ??
            "unread"}
        </output>
        <button
          onClick={() =>
            void changed(undefined, [unlinkedDocumentFill(record, "d1")])
          }
        >
          unlink
        </button>
        <button
          onClick={() =>
            void changed(undefined, [relinkedDocumentFill(record, link)])
          }
        >
          undo
        </button>
      </>
    );
  }
  render(
    <TestOpenTicket ticket={ticket}>
      <Section />
    </TestOpenTicket>,
  );
  await screen.findByText("Launch plan");
  await act(async () => screen.getByText("unlink").click());
  expect(screen.getByLabelText("documents").textContent).toBe("");
  await act(async () => screen.getByText("undo").click());
  expect(screen.getByLabelText("documents").textContent).toBe("Launch plan");
});
