import { expect, test } from "vitest";
import { planWorkModel } from "./plan-work-model";

function ticket(
  reference: string,
  {
    status = "Todo",
    availability = "Ready",
    waitsOn = [],
    trashed = false,
    updated_at = null,
  }: {
    status?: string;
    availability?: string | null;
    waitsOn?: string[];
    trashed?: boolean;
    updated_at?: string | null;
  } = {},
) {
  return {
    reference,
    title: reference,
    status,
    availability,
    trashed,
    updated_at,
    prerequisites: waitsOn.map((reference) => ({
      reference,
      title: reference,
      status: "Todo",
      trashed: false,
      unresolved: true,
    })),
  };
}

test("groups members by status and core availability and counts open and Done tickets", () => {
  const model = planWorkModel([
    ticket("T-PN1"),
    ticket("T-PN2", { availability: "Blocked" }),
    ticket("T-PN3", { status: "In progress", availability: null }),
    ticket("T-PN4", { status: "In review", availability: null }),
    ticket("T-PN5", { status: "Done", availability: null }),
    ticket("T-PN6", { status: "Canceled", availability: null }),
    ticket("T-PN7", { status: "Duplicate", availability: null }),
    ticket("T-PN8", { status: "Done", trashed: true, availability: null }),
  ]);

  expect(model.countable).toBe(5);
  expect(
    Object.fromEntries(
      Object.values(model.sections)
        .flat()
        .map(({ ticket, group }) => [ticket.reference, group]),
    ),
  ).toEqual({
    "T-PN1": "Ready",
    "T-PN2": "Blocked",
    "T-PN3": "In progress",
    "T-PN4": "In review",
    "T-PN5": "Done",
    "T-PN6": "Not counted",
    "T-PN7": "Not counted",
  });
});

test("counts distinct open dependents through shared paths and cycles", () => {
  const model = planWorkModel([
    ticket("T-PN1", { availability: "Blocked", waitsOn: ["T-PN2"] }),
    ticket("T-PN2", { availability: "Blocked", waitsOn: ["T-PN1"] }),
    ticket("T-PN3", {
      availability: "Blocked",
      waitsOn: ["T-PN1", "T-PN2"],
    }),
    ticket("T-PN4", { status: "In review", waitsOn: ["T-PN3"] }),
    ticket("T-PN5", { status: "Done", waitsOn: ["T-PN4"] }),
    ticket("T-PN6", { status: "Canceled", waitsOn: ["T-PN4"] }),
    ticket("T-PN7", { status: "Duplicate", waitsOn: ["T-PN4"] }),
    ticket("T-PN8", { trashed: true, waitsOn: ["T-PN4"] }),
    ticket("T-PN9", { availability: "Blocked", waitsOn: ["T-PN6"] }),
  ]);

  expect(
    Object.fromEntries(
      Object.values(model.sections)
        .flat()
        .map(({ ticket, unblocks }) => [ticket.reference, unblocks]),
    ),
  ).toEqual({
    "T-PN1": 3,
    "T-PN2": 3,
    "T-PN3": 1,
    "T-PN4": 0,
    "T-PN5": 0,
    "T-PN6": 1,
    "T-PN7": 0,
    "T-PN9": 0,
  });
});

test("reports unresolved visible blockers with their Plan membership", () => {
  const blocked = ticket("T-PN1", { availability: "Blocked" });
  blocked.prerequisites = [
    {
      reference: "T-PN2",
      title: "Canceled work",
      status: "Canceled",
      unresolved: true,
      trashed: false,
    },
    {
      reference: "T-OUT3",
      title: "Other Plan",
      status: "In review",
      unresolved: true,
      trashed: false,
    },
    {
      reference: "T-PN4",
      title: "Work in Trash",
      status: "Todo",
      unresolved: true,
      trashed: true,
    },
    {
      reference: "T-PN5",
      title: "Finished work",
      status: "Done",
      unresolved: false,
      trashed: false,
    },
  ];
  const model = planWorkModel([
    blocked,
    ticket("T-PN2", { status: "Canceled" }),
  ]);

  expect(
    model.sections.blocked[0]?.waitsOn.map(
      ({ reference, title, status, insidePlan }) => ({
        reference,
        title,
        status,
        insidePlan,
      }),
    ),
  ).toEqual([
    {
      reference: "T-PN2",
      title: "Canceled work",
      status: "Canceled",
      insidePlan: true,
    },
    {
      reference: "T-OUT3",
      title: "Other Plan",
      status: "In review",
      insidePlan: false,
    },
  ]);
});

function orderedPlan() {
  const review = { status: "In review" };
  const progress = { status: "In progress" };
  const done = { status: "Done" };
  const blocked = (reference: string, prerequisite: string) =>
    ticket(reference, { availability: "Blocked", waitsOn: [prerequisite] });
  const members = [
    ticket("T-PN2", { ...review, updated_at: "2026-11-02" }),
    ticket("T-PN1", { ...review, updated_at: "2026-11-03" }),
    ticket("T-PN3", { ...review, updated_at: "2026-11-01" }),
    ticket("T-PN5", { ...progress, updated_at: "2026-11-06" }),
    ticket("T-PN4", { ...progress, updated_at: "2026-11-05" }),
    ticket("T-PN10"),
    ticket("T-PN7"),
    ticket("T-PN6"),
    blocked("T-PN18", "T-OUT1"),
    blocked("T-PN14", "T-PN13"),
    blocked("T-PN13", "T-PN7"),
    blocked("T-PN12", "T-PN5"),
    blocked("T-PN11", "T-PN1"),
    blocked("T-PN19", "T-PN14"),
    blocked("T-PN20", "T-PN14"),
    ticket("T-PN15", { ...done, updated_at: "2026-11-02" }),
    ticket("T-PN16", { ...done, updated_at: "2026-11-10" }),
    ticket("T-PN21", { status: "Duplicate" }),
  ];
  return planWorkModel(members, {
    statusSince: (ticket) =>
      ticket.reference === "T-PN16" ? "2026-11-01" : ticket.updated_at,
    latestUpdate: (ticket) =>
      ticket.reference === "T-PN5" ? "2026-11-02" : ticket.updated_at,
  });
}

const references = (items: { ticket: { reference: string } }[]) =>
  items.map(({ ticket }) => ticket.reference);

test("orders review, progress, Ready, Blocked and Done for the Overview sections", () => {
  const { sections } = orderedPlan();
  expect([
    references(sections.inReview),
    references(sections.inProgress),
    references(sections.ready),
    references(sections.blocked),
    references(sections.done),
  ]).toEqual([
    ["T-PN1", "T-PN3", "T-PN2"],
    ["T-PN4", "T-PN5"],
    ["T-PN7", "T-PN6", "T-PN10"],
    ["T-PN13", "T-PN18", "T-PN12", "T-PN11", "T-PN14", "T-PN20", "T-PN19"],
    ["T-PN15", "T-PN16"],
  ]);
});

test("orders the strip from oldest Done through open groups by work unblocked", () => {
  const { strip } = orderedPlan();
  expect(references(strip)).toEqual([
    "T-PN16",
    "T-PN15",
    "T-PN1",
    "T-PN3",
    "T-PN2",
    "T-PN5",
    "T-PN4",
    "T-PN7",
    "T-PN6",
    "T-PN10",
    "T-PN13",
    "T-PN14",
    "T-PN18",
    "T-PN12",
    "T-PN11",
    "T-PN20",
    "T-PN19",
  ]);
});
