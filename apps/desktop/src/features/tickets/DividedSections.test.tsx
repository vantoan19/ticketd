// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Activity } from "./Activity";
import { OpenTicketFor } from "@/features/tickets/open-ticket/parts/activity-testing";
import { Backlinks } from "./Backlinks";
import { Evidence } from "./Evidence";
import { Subtickets } from "./Subtickets";
import type { LinkedWorkState } from "./useLinkedWork";

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

test("each major ticket section opens with its heading row, set apart by space alone", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "ticket_backlinks"
      ? [
          {
            source_reference: "T-KQ2",
            source_title: "Cache layer",
            activity_id: null,
            passage: "Blocked on T-KQ1.",
            mention_start: 11,
            mention_end: 14,
          },
        ]
      : [],
  );
  const work = {
    rows: [],
    current: {
      links: {
        children: { next_offset: null },
        children_progress: { done: 0, total: 0 },
      },
    },
    ticket: { trashed: false },
  } as unknown as LinkedWorkState;
  render(
    <>
      <Subtickets work={work} select={() => {}} />
      <OpenTicketFor reference="T-KQ1">
        <Evidence trashed={false} />
        <Backlinks select={() => {}} />
        <Activity reference="T-KQ1" projects={[]} active trashed={false} />
      </OpenTicketFor>
    </>,
  );
  await screen.findByText("Cache layer");
  for (const name of ["Subtickets", "Evidence", /^Mentioned in/, "Activity"])
    expect(headerOf(name)).not.toBeNull();
  // The count sits in the same header as the title.
  expect(headerOf(/^Mentioned in/)?.textContent).toBe("Mentioned in 1");
});
