import { expect, test } from "vitest";
import { planFlow, type FlowTicket } from "./flow-model";
const ticket = (
  reference: string,
  prerequisites: string[] = [],
  status = "Todo",
): FlowTicket => ({
  reference,
  title: reference,
  status,
  availability: prerequisites.length ? "Blocked" : "Ready",
  prerequisites: prerequisites.map((reference) => ({
    reference,
    title: reference,
    status: "Todo",
    trashed: false,
    unresolved: true,
  })),
});
test("Flow follows blocking depth even for started work and orders reference ties as S12", () => {
  const flow = planFlow([
    ticket("T-FV14"),
    ticket("T-FV15"),
    ticket("T-FV1", ["T-FV14", "T-FV15"], "In progress"),
    ticket("T-FV2", ["T-FV1"]),
    ticket("T-FV3", [], "Done"),
  ]);
  expect(flow.lanes.map((lane) => lane.map((item) => item.reference))).toEqual([
    ["T-FV15", "T-FV14"],
    ["T-FV1"],
    ["T-FV2"],
  ]);
});
test("outside blockers are depth zero and cycles and their dependents remain Later", () => {
  const flow = planFlow([
    ticket("T-FV1", ["T-AB1"]),
    ticket("T-FV2", ["T-FV3"]),
    ticket("T-FV3", ["T-FV2"]),
    ticket("T-FV4", ["T-FV3"]),
    ticket("T-FV5", [], "Canceled"),
    ticket("T-FV6", [], "Duplicate"),
  ]);
  expect(flow.lanes.map((lane) => lane.map((item) => item.reference))).toEqual([
    [],
    ["T-FV1"],
    ["T-FV3", "T-FV2", "T-FV4"],
  ]);
  expect(flow.reason(flow.lanes[1]![0]!)).toBe(
    "Waits on T-AB1 (outside this Plan)",
  );
  expect(flow.reason(flow.lanes[2]![0]!)).toBe(
    "Waits on T-FV2 (they block each other)",
  );
  expect(flow.reason(flow.lanes[2]![2]!)).toBe("Waits on T-FV3");
});
test("lane priority is status, then open dependents unblocked, then descending natural reference", () => {
  const members = [
    ticket("T-FV9"),
    ticket("T-FV10"),
    ticket("T-FV1", [], "In progress"),
    ticket("T-FV2", [], "In review"),
    ticket("T-FV3", ["T-FV9"]),
    ticket("T-FV4", ["T-FV9"]),
    ticket("T-FV5", ["T-FV10"], "Done"),
  ];
  expect(planFlow(members).lanes[0]!.map((ticket) => ticket.reference)).toEqual(
    ["T-FV1", "T-FV2", "T-FV9", "T-FV10"],
  );
});

test("overlapping cycles identify every mutually blocking member", () => {
  const flow = planFlow([
    ticket("T-FV1", ["T-FV2", "T-FV3"]),
    ticket("T-FV2", ["T-FV1"]),
    ticket("T-FV3", ["T-FV2"]),
  ]);
  expect(flow.lanes[2]).toHaveLength(3);
  for (const item of flow.lanes[2]!)
    expect(flow.reason(item)).toContain("(they block each other)");
});

test("a Canceled blocker still holds its dependent back, and the reason names its status", () => {
  const canceled = ticket("T-FV1", [], "Canceled");
  const started = {
    ...ticket("T-FV2", ["T-FV1"], "In progress"),
    prerequisites: [
      {
        reference: "T-FV1",
        title: "T-FV1",
        status: "Canceled",
        trashed: false,
        unresolved: true,
      },
      {
        reference: "T-FV9",
        title: "T-FV9",
        status: "Done",
        trashed: false,
        unresolved: false,
      },
    ],
  };
  const flow = planFlow([canceled, started]);
  expect(flow.lanes.map((lane) => lane.map((item) => item.reference))).toEqual([
    [],
    ["T-FV2"],
    [],
  ]);
  expect(flow.reason(started)).toBe("Waits on T-FV1 (Canceled)");
});

test("links between tickets that share a lane are counted as not drawn", () => {
  const flow = planFlow([
    ticket("T-FV1"),
    ticket("T-FV2", ["T-FV1"]),
    ticket("T-FV3", ["T-FV2"]),
    ticket("T-FV4", ["T-FV3"]),
  ]);
  expect(flow.edges).toHaveLength(3);
  expect(flow.undrawn).toBe(1);
});
