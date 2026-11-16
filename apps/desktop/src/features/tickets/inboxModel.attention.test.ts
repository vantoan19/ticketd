import { expect, test } from "vitest";
import {
  attentionGroup,
  approvalChats,
  needsYou,
  type Entry,
} from "./inboxModel";

const now = new Date(2026, 10, 16, 12);
const review: Entry = {
  id: 1,
  reference: "T-KQ1",
  title: "Review",
  kind: "status",
  from_value: "In progress",
  to_value: "In review",
  timestamp: now.toISOString(),
  read: true,
  editing_agent: "codex",
};
const context = {
  statuses: new Map([["T-KQ1", "In review"]]),
  reminders: new Map<string, string | null>(),
  latestStatusChanges: new Map([[review.reference, review]]),
};

test("read agent reviews need the person until the ticket leaves In review", () => {
  expect(needsYou(review, context, now)).toBe(true);
  expect(needsYou({ ...review, editing_agent: null }, context, now)).toBe(
    false,
  );
  expect(
    needsYou({ ...review, editing_agent: "local-person" }, context, now),
  ).toBe(false);
  expect(
    needsYou(
      review,
      { ...context, statuses: new Map([["T-KQ1", "Done"]]) },
      now,
    ),
  ).toBe(false);
});
test("only the current due reminder needs attention, independent of read state", () => {
  const due = new Date(2026, 10, 16, 9).toISOString();
  const entry = { ...review, kind: "reminder", to_value: due };
  expect(
    needsYou(entry, { ...context, reminders: new Map([["T-KQ1", due]]) }, now),
  ).toBe(true);
  const future = new Date(2026, 10, 17, 9).toISOString();
  expect(
    needsYou(
      { ...entry, to_value: future },
      { ...context, reminders: new Map([["T-KQ1", future]]) },
      now,
    ),
  ).toBe(false);
  expect(
    needsYou(
      entry,
      { ...context, reminders: new Map([["T-KQ1", future]]) },
      now,
    ),
  ).toBe(false);
  expect(
    needsYou(entry, { ...context, reminders: new Map([["T-KQ1", null]]) }, now),
  ).toBe(false);
});
test("only read entries before today move to Earlier", () => {
  const yesterday = new Date(2026, 10, 15, 23).toISOString();
  expect(attentionGroup({ read: true, timestamp: yesterday }, now)).toBe(
    "Earlier",
  );
  expect(attentionGroup({ read: false, timestamp: yesterday }, now)).toBe(
    "Updates",
  );
  expect(attentionGroup(review, now)).toBe("Updates");
});
test("approvals use ranked status and preserve linked-ticket order and Chat identity", () => {
  const approval = {
    id: "chat1",
    status: { rank: "approval" },
    tickets: [{ reference: "T-KQ2" }, { reference: "T-KQ1" }],
  };
  expect(
    approvalChats([
      { ...approval, id: "question", status: { rank: "question" } },
      approval,
    ]),
  ).toEqual([approval]);
});

test("a historical agent review does not reactivate after a later local transition to In review", () => {
  const later = {
    ...review,
    timestamp: new Date(2026, 10, 16, 13).toISOString(),
    editing_agent: null,
  };
  expect(
    needsYou(
      review,
      { ...context, latestStatusChanges: new Map([[review.reference, later]]) },
      new Date(2026, 10, 16, 14),
    ),
  ).toBe(false);
});
