// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Activity } from "./Activity";
import { OpenTicketFor } from "@/features/tickets/open-ticket/parts/activity-testing";
import { LinkedWork } from "./LinkedWork";
import { useLinkedWork } from "./useLinkedWork";
import { bridgeDefault } from "@/test/bridge-defaults";
import { Evidence } from "./Evidence";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

/** The header row that opens the section named `name`. */
const headerOf = (name: RegExp | string) =>
  screen
    .getByRole("heading", { name })
    .closest<HTMLElement>('[data-slot="section-header"]');

function TicketLinks() {
  const work = useLinkedWork();
  return <LinkedWork work={work} select={() => {}} onMention={() => {}} />;
}

test("major ticket sections use visible headings and mentions live in Linked", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "ticket_backlinks"
      ? {
          total: 1,
          items: [
            {
              reference: "T-KQ2",
              title: "Cache layer",
              status: "In review",
              mentioned_at: "2026-10-31T10:00:00Z",
              passages: [
                {
                  activity_id: null,
                  passage: "Blocked on T-KQ1.",
                  mention_start: 11,
                  mention_end: 16,
                },
              ],
            },
          ],
        }
      : bridgeDefault(command),
  );
  render(
    <OpenTicketFor reference="T-KQ1">
      <TicketLinks />
      <Evidence trashed={false} />
      <Activity reference="T-KQ1" projects={[]} active trashed={false} />
    </OpenTicketFor>,
  );
  await screen.findByRole("button", {
    name: /Mentioned in 1 ticket/,
    expanded: false,
  });
  for (const name of ["Linked", "Evidence", "Activity"])
    expect(headerOf(name)).not.toBeNull();
});
