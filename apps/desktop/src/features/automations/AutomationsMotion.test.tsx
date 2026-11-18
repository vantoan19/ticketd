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
import { Position, type EdgeProps } from "@xyflow/react";
import { MotionProvider } from "@/components/ui/motion";
import { AutomationsView } from "@/features/automations/AutomationsView";
import { DrawnEdge } from "@/features/automations/FlowCanvas";
import type {
  Automation,
  AutomationDefinition,
} from "@/features/automations/client";
import { fakeStored } from "@/features/automations/fake-core";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { selectAutomationView } from "@/test/automation-navigation";

// Opening Automations (DESIGN.md section 12): the page header, then the rest of
// the page (the list, or the empty state and each starter) fades up in turn; in the editor a step added to an open flow takes
// the same entrance and its connecting line draws. The steps a flow opens with
// do not move. Timing comes from the tokens, so these tests apply the real ones.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

let stored: Automation[] = [];
let agents: unknown[] = [];
let runs: unknown[] = [];
beforeEach(() => {
  stored = [];
  agents = [];
  runs = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { definition } = (args ?? {}) as {
      definition?: AutomationDefinition;
    };
    switch (command) {
      case "automation_list":
        return stored;
      case "automation_update":
        stored = [fakeStored(stored[0]!, definition ?? {})];
        return stored[0];
      case "automation_run_list_all":
        return runs;
      case "automation_agent_list":
        return agents;
      case "automation_run_list":
        return [];
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  restoreTokens = applyTokens(rootTokens);
});
let restoreTokens: () => void;
afterEach(() => {
  cleanup();
  restoreTokens();
});

const page = () =>
  render(
    <MotionProvider>
      <ChatClientContext value={createMockChatClient()}>
        <AutomationsView />
      </ChatClientContext>
    </MotionProvider>,
  );
const steps = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>("[data-enter]"),
];

const stepOf = (element: HTMLElement) =>
  element.style.getPropertyValue("--enter-step");

test("an empty Automations page enters header first, then the empty state, the label and each starter, a stagger step apart", async () => {
  const { container } = page();
  const examples = await screen.findByRole("group", {
    name: "Start from an example",
  });
  expect(
    container
      .querySelector(".plan-workspace")
      ?.hasAttribute("data-own-entrance"),
  ).toBe(true);
  const arrivals = steps(container);
  expect(arrivals.map((each) => [stepOf(each), each.textContent])).toEqual([
    ["0", expect.stringContaining("Automations")],
    ["1", expect.stringContaining("No Automations yet")],
    ["1", expect.stringContaining("Let agents act on tickets for you")],
    ["2", "Start from an example"],
    ["3", expect.stringContaining("Triage tagged tickets")],
    ["4", expect.stringContaining("Verify what is ready for testing")],
    ["5", expect.stringContaining("Weekly summary")],
  ]);
  // The header is the page's pane header, not a stand-in.
  expect(
    arrivals[0]?.querySelector('[data-slot="pane-header"]'),
  ).not.toBeNull();
  expect(within(examples).getAllByRole("button")).toHaveLength(3);
});

const used = () =>
  fakeStored(
    {
      id: "automation-1",
      name: "Verify on staging",
      trigger: { kind: "tag_added", tag: "ready-for-testing" },
      conditions: [],
      steps: [],
      enabled: false,
      arrived_off: false,
      problems: [],
      has_ticket: true,
    } as Automation,
    {},
  );

test("a page with Automations enters header first, then the list; the page still owns its entrance", async () => {
  stored = [used()];
  const { container } = page();
  const list = await screen.findByRole("list", { name: "Automations" });
  expect(
    container
      .querySelector(".plan-workspace")
      ?.hasAttribute("data-own-entrance"),
  ).toBe(true);
  const arrivals = steps(container);
  expect(arrivals.map(stepOf)).toEqual(["0", "1"]);
  expect(
    arrivals[0]?.querySelector('[data-slot="pane-header"]'),
  ).not.toBeNull();
  expect(arrivals[1]).toBe(list);
});

test("the Agents and Runs tabs enter their list after the header, too", async () => {
  stored = [used()];
  agents = [
    {
      id: "agent-1",
      name: "Reviewer",
      harness: "codex",
      model: null,
      instructions: "",
      tools: {
        read_files: true,
        edit_files: false,
        run_commands: false,
        any_command: false,
        allowed_commands: [],
        use_web: false,
      },
      turn_limit: 40,
      time_limit_minutes: 20,
    },
  ];
  runs = [
    {
      id: "1",
      automation_id: "automation-1",
      automation_name: "Verify on staging",
      status: "completed",
      reason: null,
      needs_you: false,
      answer: null,
      automation_deleted: false,
      ticket: { id: "1", reference: "T-1", title: "Login flickers" },
      created_at: new Date().toISOString(),
    },
  ];
  const { container } = page();
  await screen.findByRole("list", { name: "Automations" });
  await selectAutomationView("Agents");
  const list = await screen.findByRole("list", { name: "Agents" });
  expect(steps(container).map(stepOf)).toEqual(["0", "1"]);
  expect(steps(container)[1]).toBe(list);
  await selectAutomationView("Runs");
  await screen.findByRole("list", { name: /^Runs, / });
  const arrivals = steps(container);
  expect(arrivals.map(stepOf)).toEqual(["0", "1"]);
  expect(arrivals[1]?.querySelector("ul.auto-runs")).not.toBeNull();
});

test("the header count is one child, so a changed count crossfades", async () => {
  stored = [used()];
  const { container } = page();
  await screen.findByRole("list", { name: "Automations" });
  const count = container.querySelector<HTMLElement>(
    '[data-slot="pane-header"] [data-slot="count"]',
  );
  // Count crossfades only a plain number or string: a number beside a word for
  // screen readers is an array of children, and would swap in place.
  expect(count?.querySelector('[data-slot="crossfade"]')).not.toBeNull();
  expect(count?.textContent).toBe("1");
  // The screen-reader word still follows the number.
  expect(
    container.querySelector('[data-slot="pane-header"] .sr-only')?.textContent,
  ).toMatch(/automations/i);
});

test("a step added to an open flow arrives and its line draws; the steps it opened with do not move", async () => {
  stored = [
    fakeStored(
      {
        id: "automation-1",
        name: "Verify on staging",
        trigger: { kind: "tag_added", tag: "ready-for-testing" },
        conditions: [],
        steps: [
          {
            id: "first",
            kind: "notify",
            text: "Tagged",
            opens: "ticket",
            on_failure: null,
          },
        ],
        enabled: false,
        arrived_off: false,
        problems: [],
        has_ticket: true,
      } as Automation,
      {},
    ),
  ];
  const { container } = page();
  const rows = await screen.findByRole("list", { name: "Automations" });
  fireEvent.click((await within(rows).findAllByRole("button"))[0]!);
  const steps = await screen.findByRole("application", { name: "Steps" });
  await within(steps).findByRole("button", { name: /^Notify/ });
  expect(
    container.querySelectorAll('.flow-canvas [data-slot="appear"]'),
  ).toHaveLength(0);

  const adders = within(steps).getAllByRole("button", { name: /^Add a step/ });
  fireEvent.keyDown(adders[adders.length - 1]!, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Notify me/ }));

  await waitFor(() =>
    expect(
      container.querySelectorAll('.flow-canvas [data-slot="appear"]'),
    ).toHaveLength(1),
  );
  expect(
    container
      .querySelector('.flow-canvas [data-slot="appear"]')
      ?.getAttribute("data-slot"),
  ).toBe("appear");
});

test("a step's connecting line is drawn along its length, straight or bending to a path", () => {
  const geometry = {
    id: "line",
    sourceX: 10,
    sourceY: 0,
    sourcePosition: Position.Bottom,
    targetX: 10,
    targetY: 80,
    targetPosition: Position.Top,
  };
  const { container } = render(
    <svg>
      <DrawnEdge {...(geometry as EdgeProps)} data={{ smooth: false }} />
      <DrawnEdge
        {...(geometry as EdgeProps)}
        id="bent"
        targetX={90}
        data={{ smooth: true }}
      />
    </svg>,
  );
  const [straight, bent] = [...container.querySelectorAll("path.ui-drawn")];
  expect(straight?.getAttribute("pathLength")).toBe("1");
  expect(straight?.getAttribute("d")).toBe("M 10,0L 10,80");
  expect(bent?.getAttribute("pathLength")).toBe("1");
  expect(bent?.getAttribute("d")).toContain("90");
});
