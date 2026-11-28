// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import type { Attachment } from "@/lib/api/attachments";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

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

const plan = { id: "launch", name: "Launch", purpose: "", archived: false };
const members = [
  { reference: "T-1", title: "Ship it", status: "Done" },
  { reference: "T-2", title: "Prepare the site", status: "Todo" },
  { reference: "T-3", title: "Approve the release", status: "In review" },
  { reference: "T-4", title: "Check the report", status: "In progress" },
].map((ticket) => ({
  ...ticket,
  id: `ticket-${ticket.reference}`,
  availability: ticket.status === "Todo" ? "Ready" : null,
  updated_at: "2026-11-28T01:00:00Z",
  plan_id: plan.id,
  project_id: null,
  body: "",
  tags: [],
  trashed: false,
  parent: null,
  children: [],
  prerequisites: [],
}));

function attachment(name: string, filename: string): Attachment {
  return {
    id: filename,
    display_name: name,
    original_filename: filename,
    size_bytes: 10,
    kind: "local_snapshot",
    locator: `files/${filename}`,
  };
}

const shared = attachment("Results", "results.csv");
const reviewFiles = [
  shared,
  ...Array.from({ length: 5 }, (_, index) =>
    attachment(`Note ${index + 1}`, `note-${index + 1}.txt`),
  ),
];
const filesByTicket = [
  [attachment("Archive", "release.zip")],
  [attachment("Checklist", "checklist.pdf")],
  reviewFiles,
  [shared, attachment("Report", "report.html")],
];
const groups = members.map(({ reference, title, status }, index) => ({
  reference,
  title,
  status,
  files: filesByTicket[index] ?? [],
}));

async function openPlan({ archived = false, withFiles = true } = {}) {
  invoke.mockImplementation(
    async (command: string, args?: { id?: string; reference?: string }) => {
      switch (command) {
        case "workspace_change_token":
          return 0;
        case "list_plans":
          return [{ ...plan, archived }];
        case "show_plan":
          return {
            plan: { ...plan, archived },
            members,
            counts: {
              todo: 1,
              in_review: 1,
              in_progress: 1,
              done: 1,
              canceled: 0,
            },
          };
        case "plan_files":
          return withFiles ? groups : [];
        case "find_tickets_with_updates":
          return [];
        case "show_ticket":
          return members.find((ticket) => ticket.reference === args?.reference);
        case "attachment_preview":
          return {
            attachment: filesByTicket.flat().find(({ id }) => id === args?.id),
            status: "unavailable",
            media_type: null,
            can_open: false,
            message: "File bytes are unavailable",
            usage: { total: 0, entries: [], legacy_drafts_pending: false },
          };
        default:
          return bridgeDefault(command, args);
      }
    },
  );
  render(<App />);
  const user = userEvent.setup();
  if (archived) {
    await user.click(await screen.findByRole("button", { name: "Plans" }));
    await user.click(await screen.findByRole("radio", { name: "Archived" }));
  }
  await user.click(
    await screen.findByRole("button", {
      name: archived ? "Open Plan Launch" : "Launch",
    }),
  );
  const overview = await screen.findByRole("region", { name: "Launch" });
  return { overview, user };
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

test("the Files section follows the Overview order and folds groups and thumbnails", async () => {
  const { overview, user } = await openPlan();
  const files = within(
    await within(overview).findByRole("region", { name: "Files" }),
  );

  expect(files.getByRole("heading", { name: "Files 10" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("plan_files", { id: "launch" });
  expect(files.getAllByRole("heading", { level: 3 })).toEqual([
    files.getByRole("heading", { name: "In review T-3 Approve the release" }),
    files.getByRole("heading", { name: "In progress T-4 Check the report" }),
    files.getByRole("heading", { name: "Todo T-2 Prepare the site" }),
  ]);
  expect(files.getAllByText("CSV")).toHaveLength(2);
  expect(files.getAllByText("TXT")).toHaveLength(4);
  expect(files.getByText("+1")).toBeTruthy();
  expect(files.queryByRole("button", { name: "Note 5" })).toBeNull();

  await user.click(files.getByRole("button", { name: "Show 1 more ticket" }));
  expect(files.getByRole("heading", { name: /T-1 Ship it/ })).toBeTruthy();
  expect(files.getByText("ZIP")).toBeTruthy();
});

test("Go through all steps across tickets, including reuse of one attachment", async () => {
  const { overview, user } = await openPlan();
  await user.click(
    await within(overview).findByRole("button", { name: "Go through all" }),
  );
  const viewer = within(await screen.findByRole("dialog", { name: "Results" }));
  const position = viewer.getByRole("group", { name: "Browse files" });
  const next = viewer.getByRole("button", { name: "Next file" });
  const previous = viewer.getByRole("button", { name: "Previous file" });
  expect(viewer.getByRole("img", { name: "In review" })).toBeTruthy();
  expect(viewer.getByText("Approve the release")).toBeTruthy();
  expect(previous).toHaveProperty("disabled", true);

  for (const [index, name] of [
    "Note 1",
    "Note 2",
    "Note 3",
    "Note 4",
    "Note 5",
    "Results",
    "Report",
    "Checklist",
    "Archive",
  ].entries()) {
    await user.click(next);
    expect(viewer.getByRole("heading", { name })).toBeTruthy();
    expect(within(position).getByText(`${index + 2} of 10`)).toBeTruthy();
    if (index === 5) {
      expect(viewer.getByRole("img", { name: "In progress" })).toBeTruthy();
      expect(viewer.getByText("T-4")).toBeTruthy();
      expect(viewer.getByText("Check the report")).toBeTruthy();
    }
  }
  expect(viewer.getByRole("button", { name: "Next file" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.keyboard("k");
  expect(viewer.getByRole("heading", { name: "Checklist" })).toBeTruthy();
  await user.keyboard("j");
  expect(viewer.getByRole("heading", { name: "Archive" })).toBeTruthy();

  await user.click(viewer.getByRole("button", { name: "Open ticket" }));
  expect(
    await screen.findByRole("button", { name: "Close ticket details" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "T-1" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(invoke).toHaveBeenCalledWith(
    "show_ticket",
    expect.objectContaining({ reference: "T-1" }),
  );
});

test("work row paperclips open the ticket's own files", async () => {
  const { overview, user } = await openPlan();
  const review = within(
    within(overview).getByRole("region", { name: "Needs you" }),
  );
  const progress = within(
    within(overview).getByRole("region", { name: "In progress" }),
  );
  const reviewFiles = await review.findByRole("button", {
    name: "6 files for T-3",
  });
  await user.click(reviewFiles);
  let viewer = within(await screen.findByRole("dialog", { name: "Results" }));
  expect(
    within(viewer.getByRole("group", { name: "Browse files" })).getByText(
      "1 of 6",
    ),
  ).toBeTruthy();
  await user.click(viewer.getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(reviewFiles);

  await user.click(progress.getByRole("button", { name: "2 files for T-4" }));
  viewer = within(await screen.findByRole("dialog", { name: "Results" }));
  expect(
    within(viewer.getByRole("group", { name: "Browse files" })).getByText(
      "1 of 2",
    ),
  ).toBeTruthy();
  expect(viewer.getByText("Check the report")).toBeTruthy();
});

test("archived Plans keep only the Files heading and the full walk", async () => {
  const { overview, user } = await openPlan({ archived: true });
  const files = within(
    await within(overview).findByRole("region", { name: "Files" }),
  );
  expect(files.getByRole("heading", { name: "Files 10" })).toBeTruthy();
  expect(files.getAllByRole("button")).toEqual([
    files.getByRole("button", { name: "Go through all" }),
  ]);
  await user.click(files.getByRole("button", { name: "Go through all" }));
  const viewer = within(await screen.findByRole("dialog", { name: "Results" }));
  expect(
    within(viewer.getByRole("group", { name: "Browse files" })).getByText(
      "1 of 10",
    ),
  ).toBeTruthy();
});

test("a Plan without files has no Files section or paperclip actions", async () => {
  const { overview } = await openPlan({ withFiles: false });
  expect(within(overview).queryByRole("region", { name: "Files" })).toBeNull();
  expect(
    within(overview).queryByRole("button", { name: /files for/ }),
  ).toBeNull();
});
