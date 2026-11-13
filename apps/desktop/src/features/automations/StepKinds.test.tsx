// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AutomationsView } from "@/features/automations/AutomationsView";
import type {
  Automation,
  AutomationDefinition,
} from "@/features/automations/client";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

/** The fake Workspace: one Automation, changed by the commands the page sends. */
let stored: Automation;
const saved = () => stored.steps as Record<string, unknown>[];
beforeEach(() => {
  stored = {
    id: "automation-1",
    name: "Verify on staging",
    trigger: { kind: "tag_added", tag: "ready-for-testing" },
    conditions: [],
    steps: [],
    enabled: false,
    arrived_off: false,
    problems: [],
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { definition, text, tag } = (args ?? {}) as {
      definition?: AutomationDefinition;
      text?: string;
      tag?: string | null;
    };
    switch (command) {
      case "automation_list":
        return [stored];
      case "automation_agent_list":
        return [];
      case "automation_update":
        stored = { ...stored, ...definition };
        return stored;
      // The core fills the fields in; here every field reads as the same ticket.
      case "automation_text_preview":
        return (text ?? "")
          .replaceAll("{{ticket.reference}}", "T-ZB5")
          .replaceAll("{{event.tag}}", tag ?? "");
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const open = async (trigger?: Automation["trigger"]) => {
  if (trigger) stored = { ...stored, trigger };
  render(
    <ChatClientContext value={createMockChatClient()}>
      <AutomationsView />
    </ChatClientContext>,
  );
  const rows = await screen.findByRole("list", { name: "Automations" });
  fireEvent.click(within(rows).getAllByRole("button")[0]!);
  return screen.findByRole("application", { name: "Steps" });
};
/** Opens the menu a button carries and chooses an item from it. */
const choose = async (button: HTMLElement, item: RegExp) => {
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
};
const add = (steps: HTMLElement, kind: RegExp) =>
  choose(within(steps).getByRole("button", { name: /^Add a step/ }), kind);

test("a Change ticket step is added from the + and says on its card what it changes", async () => {
  const steps = await open();

  await add(steps, /Change ticket/);
  const panel = await screen.findByRole("complementary", {
    name: "Change ticket",
  });
  fireEvent.change(within(panel).getByLabelText("Tag"), {
    target: { value: "Needs-Fix" },
  });

  await waitFor(() =>
    expect(saved()).toMatchObject([
      {
        kind: "change_ticket",
        change: { action: "add_tag", tag: "needs-fix" },
      },
    ]),
  );
  expect(
    within(steps).getByRole("button", {
      name: "Change ticket: Add tag needs-fix",
    }),
  ).toBeTruthy();
});

test("a field is inserted into a message as a named chip, saved as a plain reference, and previewed with a recent ticket", async () => {
  const steps = await open();

  await add(steps, /Notify me/);
  const panel = await screen.findByRole("complementary", { name: "Notify me" });
  const message = within(panel).getByRole("textbox", { name: "Message" });
  message.textContent = "Verified ";
  fireEvent.input(message);
  await choose(
    within(panel).getByRole("button", { name: "Insert field" }),
    /Ticket reference/,
  );
  await choose(
    within(panel).getByRole("button", { name: "Insert field" }),
    /Tag from the event/,
  );

  // The person reads names; the record holds references, resolved at run time.
  expect(message.textContent).toBe(
    "Verified Ticket referenceTag from the event",
  );
  await waitFor(() =>
    expect(saved()).toMatchObject([
      {
        kind: "notify",
        text: "Verified {{ticket.reference}}{{event.tag}}",
        opens: "ticket",
      },
    ]),
  );
  const preview = within(panel).getByRole("group", { name: "Preview" });
  await waitFor(() =>
    expect(preview.textContent).toContain("Verified T-ZB5ready-for-testing"),
  );
  expect(preview.textContent).toContain("Verify on staging");
  // The card names the fields too.
  expect(
    within(steps).getByRole("button", {
      name: "Notify me: Verified Ticket reference Tag from the event",
    }),
  ).toBeTruthy();

  fireEvent.click(within(panel).getByRole("radio", { name: "The run" }));
  await waitFor(() => expect(saved()).toMatchObject([{ opens: "run" }]));
});

test("Change ticket is unavailable, with the reason, when the Automation does not start from a ticket", async () => {
  const steps = await open({ kind: "by_hand" });

  fireEvent.keyDown(
    within(steps).getByRole("button", { name: /^Add a step/ }),
    { key: "Enter" },
  );

  const item = await screen.findByRole("menuitem", { name: /Change ticket/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain("Needs a ticket");
  expect(
    screen
      .getByRole("menuitem", { name: /Notify me/ })
      .getAttribute("aria-disabled"),
  ).toBeNull();
});
