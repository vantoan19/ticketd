// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import { bridgeDefault } from "@/test/bridge-defaults";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const plan = { id: "release", name: "Launch", archived: false, purpose: "" };
const member = (
  number: number,
  title: string,
  status: string,
  availability: "Ready" | "Blocked" | null = null,
  prerequisites: { reference: string; title: string; status: string }[] = [],
  parent: { reference: string; title: string } | null = null,
  updated_at = "2026-11-28T01:00:00Z",
) => ({
  id: `ticket-${number}`,
  reference: `T-${number}`,
  title,
  status,
  availability,
  prerequisites: prerequisites.map((blocker) => ({
    reference: blocker.reference,
    title: blocker.title,
    status: blocker.status,
    unresolved: true,
    trashed: false,
  })),
  parent: parent && {
    reference: parent.reference,
    title: parent.title,
    trashed: false,
  },
  updated_at,
  body: "",
  trashed: false,
  tags: [],
  children: [],
  project_id: null,
  plan_id: plan.id,
});

const update = (text: string, reported_at = "2026-11-28T02:00:00Z") => ({
  activity_id: "update",
  brief: { text, truncated: false },
  reported_at,
  updated_at: reported_at,
  editing_agent: null,
  supporting_document_id: null,
});

type Member = ReturnType<typeof member>;
type Update = ReturnType<typeof update>;

async function openPlan(
  members: Member[],
  latest_updates: Record<string, Update> = {},
  chatEnabled = false,
  facts: { status_since?: Record<string, string>; pull_request?: string } = {},
) {
  const count = (status: string) =>
    members.filter((ticket) => ticket.status === status).length;
  invoke.mockImplementation(
    async (
      command: string,
      args?: { reference?: string; projection?: string },
    ) => {
      switch (command) {
        case "list_plans":
          return [plan];
        case "show_plan":
          return {
            plan,
            members,
            latest_updates,
            status_since: Object.fromEntries(
              members.map((ticket) => [ticket.reference, ticket.updated_at]),
            ),
            ...facts,
            counts: {
              todo: count("Todo"),
              in_review: count("In review"),
              in_progress: count("In progress"),
              done: count("Done"),
              canceled: count("Canceled"),
              duplicate: count("Duplicate"),
            },
          };
        case "open_plan_pull_request":
          return null;
        case "show_ticket":
          return members.find((ticket) => ticket.reference === args?.reference);
        case "find_tickets_with_updates":
          return args?.projection ? { items: [], omitted: false } : [];
        default:
          return bridgeDefault(command);
      }
    },
  );
  const client = createMockChatClient({ enabled: chatEnabled, chats: [] });
  const create = vi.spyOn(client, "createChat");
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  return {
    overview: await screen.findByRole("region", { name: "Launch" }),
    create,
  };
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.restoreAllMocks();
});

test("groups the work in reading order and puts the reviews and ready tickets that unblock the most first", async () => {
  const firstReview = member(21, "Check the copy", "In review");
  const importantReview = member(22, "Approve release", "In review");
  const parent = member(31, "Plan follow-up", "Todo", "Ready");
  const firstReady = member(32, "Prepare release", "Todo", "Ready");
  const blocked = member(
    41,
    "Publish",
    "Todo",
    "Blocked",
    [importantReview, firstReady],
    parent,
  );
  const olderUpdate = member(
    23,
    "Check the reports",
    "In progress",
    null,
    [],
    null,
    "2026-11-28T05:00:00Z",
  );
  const newerUpdate = member(24, "Check the build", "In progress");
  const { overview } = await openPlan(
    [
      firstReview,
      importantReview,
      parent,
      firstReady,
      blocked,
      olderUpdate,
      newerUpdate,
    ],
    {
      "T-22": update(
        "**Verified** [the release](https://example.com). Second sentence.",
      ),
      "T-23": update("The reports are ready."),
      "T-24": update("The build is ready. Keep going.", "2026-11-28T03:00:00Z"),
    },
  );

  const regions = within(overview);
  const review = await regions.findByRole("region", { name: "Needs you" });
  const inProgress = regions.getByRole("region", { name: "In progress" });
  const ready = regions.getByRole("region", { name: "Ready" });
  const waiting = regions.getByRole("region", { name: "Blocked" });
  expect(
    regions.getAllByRole("region", {
      name: /^(Needs you|In progress|Ready|Blocked)$/,
    }),
  ).toEqual([review, inProgress, ready, waiting]);
  expect(within(review).getAllByRole("button")).toEqual([
    within(review).getByRole("button", { name: /T-22 Approve release/ }),
    within(review).getByRole("button", { name: /T-21 Check the copy/ }),
  ]);
  expect(within(review).getByText("Verified the release.")).toBeTruthy();
  expect(within(review).queryByText(/Second sentence/)).toBeNull();
  expect(within(inProgress).getAllByRole("button")).toEqual([
    within(inProgress).getByRole("button", { name: /T-24 Check the build/ }),
    within(inProgress).getByRole("button", { name: /T-23 Check the reports/ }),
  ]);
  expect(within(inProgress).getByText("The build is ready.")).toBeTruthy();
  expect(within(ready).getAllByRole("button")).toEqual([
    within(ready).getByRole("button", { name: /T-32 Prepare release/ }),
    within(ready).getByRole("button", { name: /T-31 Plan follow-up/ }),
  ]);
  expect(within(ready).getByText("Unblocks 1")).toBeTruthy();
  expect(within(ready).getByText("Parent of 1")).toBeTruthy();
  expect(
    within(waiting).getByRole("button", { name: /T-41 Publish.*T-22.*T-32/ }),
  ).toBeTruthy();
  expect(within(waiting).getByText("after T-22 +1")).toBeTruthy();
  expect(regions.queryByRole("button", { name: /Start in Chat/ })).toBeNull();
});

test("folds more than three blocked tickets and separates canceled and duplicate work inside Done", async () => {
  const external = member(99, "External work", "Todo", "Ready");
  const blocked = [41, 42, 43, 44].map((number) =>
    member(number, `Publish part ${number}`, "Todo", "Blocked", [external]),
  );
  const { overview } = await openPlan([
    ...blocked,
    member(51, "Older finish", "Done"),
    member(52, "Newer finish", "Done", null, [], null, "2026-11-28T04:00:00Z"),
    member(53, "Canceled work", "Canceled"),
    member(54, "Duplicate work", "Duplicate"),
  ]);
  const blockedSection = await within(overview).findByRole("region", {
    name: "Blocked",
  });
  const doneSection = within(overview).getByRole("region", { name: "Done" });
  const blockedFold = within(blockedSection).getByRole("button", {
    name: "Blocked 4",
  });
  const doneFold = within(doneSection).getByRole("button", { name: "Done 2" });
  expect(blockedFold.getAttribute("aria-expanded")).toBe("false");
  expect(doneFold.getAttribute("aria-expanded")).toBe("false");
  expect(
    within(blockedSection).queryByRole("button", { name: /T-44/ }),
  ).toBeNull();
  expect(
    within(doneSection).queryByRole("region", { name: "Not counted" }),
  ).toBeNull();

  fireEvent.click(blockedFold);
  expect(
    within(blockedSection)
      .getAllByRole("button", { name: /Publish part/ })
      .map((row) => row.getAttribute("aria-label")?.split(" ")[0]),
  ).toEqual(["T-44", "T-43", "T-42", "T-41"]);

  fireEvent.click(doneFold);
  const [newest, oldest] = within(doneSection).getAllByRole("button", {
    name: /finish/,
  });
  expect(newest).toBe(
    within(doneSection).getByRole("button", { name: /T-52 Newer finish/ }),
  );
  expect(oldest).toBe(
    within(doneSection).getByRole("button", { name: /T-51 Older finish/ }),
  );
  const notCounted = within(doneSection).getByRole("region", {
    name: "Not counted",
  });
  expect(
    within(notCounted).getByRole("button", { name: /T-53 Canceled work/ }),
  ).toBeTruthy();
  expect(
    within(notCounted).getByRole("button", { name: /T-54 Duplicate work/ }),
  ).toBeTruthy();
});

test("J and K move between visible rows, Enter opens beside the Plan, and closing returns focus", async () => {
  const { overview } = await openPlan([
    member(11, "Review copy", "In review"),
    member(12, "Build package", "Todo", "Ready"),
    member(13, "Write release notes", "Done"),
  ]);
  const user = userEvent.setup();
  const reviewSection = await within(overview).findByRole("region", {
    name: "Needs you",
  });
  const readySection = within(overview).getByRole("region", { name: "Ready" });
  const review = within(reviewSection).getByRole("button", {
    name: /T-11 Review copy/,
  });
  const ready = within(readySection).getByRole("button", {
    name: /T-12 Build package/,
  });
  await user.click(
    within(overview).getByRole("button", { name: "Add purpose" }),
  );
  const purpose = within(overview).getByRole("textbox", { name: "Purpose" });
  await user.keyboard("jk");
  expect(document.activeElement).toBe(purpose);
  expect(purpose).toHaveProperty("value", "jk");
  await user.keyboard("{Escape}");

  review.focus();
  await user.keyboard("j");
  expect(document.activeElement).toBe(ready);
  await user.keyboard("j");
  expect(document.activeElement).toBe(ready);
  await user.keyboard("k");
  expect(document.activeElement).toBe(review);
  await user.keyboard("{Enter}");
  expect(invoke).toHaveBeenCalledWith("show_ticket", { reference: "T-11" });
  expect(review.getAttribute("aria-current")).toBe("true");
  expect(ready.hasAttribute("aria-current")).toBe(false);

  const close = await screen.findByRole("button", {
    name: "Close ticket details",
  });
  await user.click(close);
  await waitFor(() => expect(document.activeElement).toBe(review));
  expect(review.hasAttribute("aria-current")).toBe(false);
});

test("closing a ticket opened from the strip focuses its work row", async () => {
  const { overview } = await openPlan([
    member(11, "Review copy", "In review"),
    member(12, "Build package", "Todo", "Ready"),
  ]);
  const toolbar = within(overview).getByRole("toolbar", {
    name: "Plan progress",
  });
  const section = within(overview).getByRole("region", { name: "Needs you" });
  const row = within(section).getByRole("button", { name: /T-11 Review copy/ });
  const user = userEvent.setup();

  await user.click(
    within(toolbar).getByRole("button", { name: /T-11 Review copy/ }),
  );
  const close = await screen.findByRole("button", {
    name: "Close ticket details",
  });
  await user.click(close);

  await waitFor(() => expect(document.activeElement).toBe(row));
});

test("Start in Chat opens an unsent draft about the Ready ticket", async () => {
  const { overview, create } = await openPlan(
    [
      member(31, "Ship build", "Todo", "Ready"),
      member(32, "Check copy", "In review"),
    ],
    {},
    true,
  );
  const ready = await within(overview).findByRole("region", { name: "Ready" });
  const review = within(overview).getByRole("region", { name: "Needs you" });
  expect(
    within(review).queryByRole("button", { name: /Start in Chat/ }),
  ).toBeNull();
  fireEvent.click(
    within(ready).getByRole("button", { name: "Start in Chat: T-31" }),
  );
  const box = await screen.findByRole("textbox", {
    name: "Describe a task or ask a question",
  });
  expect(box).toHaveProperty("value", "Work on T-31: Ship build");
  expect(screen.getByRole("button", { name: "Back to T-31" })).toBeTruthy();
  expect(create).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("show_ticket", { reference: "T-31" });
});

test("shows time in each current status and puts longer waiting reviews first after unblocking priority", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-28T12:00:00Z"));
  const recent = member(21, "Recent review", "In review");
  const oldest = member(22, "Old review", "In review");
  const mostUnblocking = member(23, "Release review", "In review");
  const { overview } = await openPlan(
    [
      recent,
      oldest,
      mostUnblocking,
      member(31, "Writing tests", "In progress"),
      member(41, "Prepare the notes", "Todo", "Ready"),
      member(51, "Publish release", "Todo", "Blocked", [mostUnblocking]),
      member(61, "Finish review", "Done"),
    ],
    {},
    false,
    {
      status_since: {
        "T-21": "2026-11-28T09:00:00Z",
        "T-22": "2026-11-27T12:00:00Z",
        "T-23": "2026-11-28T11:30:00Z",
        "T-31": "2026-11-28T10:00:00Z",
        "T-41": "2026-11-26T12:00:00Z",
        "T-51": "2026-11-25T12:00:00Z",
        "T-61": "2026-11-24T12:00:00Z",
      },
    },
  );
  const regions = within(overview);
  const needsYou = within(
    await regions.findByRole("region", { name: "Needs you" }),
  );
  expect(needsYou.getAllByRole("button")).toEqual([
    needsYou.getByRole("button", { name: /Release review/ }),
    needsYou.getByRole("button", { name: /Old review/ }),
    needsYou.getByRole("button", { name: /Recent review/ }),
  ]);
  expect(needsYou.getAllByRole("time").map((time) => time.textContent)).toEqual(
    ["30m", "1d", "3h"],
  );
  for (const [name, time] of [
    ["In progress", "2h"],
    ["Ready", "2d"],
    ["Blocked", "3d"],
  ] as const) {
    expect(
      within(regions.getByRole("region", { name })).getByRole("time")
        .textContent,
    ).toBe(time);
  }
  const done = within(regions.getByRole("region", { name: "Done" }));
  fireEvent.click(done.getByRole("button", { name: "Done 1" }));
  expect(done.getByRole("time").textContent).toBe("4d");
  expect(done.getByRole("time").getAttribute("datetime")).toBe(
    "2026-11-24T12:00:00Z",
  );
});

test("opens the pull request from the number in its URL", async () => {
  const url = "https://github.com/example/app/pull/616?view=files";
  const { overview } = await openPlan([], {}, false, { pull_request: url });
  const pr = await within(overview).findByRole("button", {
    name: "Pull request #616",
  });
  expect(pr.textContent).toBe("#616");
  fireEvent.click(pr);
  expect(invoke).toHaveBeenCalledWith("open_plan_pull_request", {
    id: plan.id,
    url,
  });
});

test("the Plan head has no pull request action when no member has one", async () => {
  const { overview } = await openPlan([
    member(21, "Approve release", "In review"),
  ]);
  await within(overview).findByRole("region", { name: "Needs you" });
  expect(
    within(overview).queryByRole("button", { name: /pull request/i }),
  ).toBeNull();
});
