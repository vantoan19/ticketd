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

// Opening Automations (DESIGN.md section 12): the page header, then each
// starter fades up in turn; in the editor a step added to an open flow takes
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
beforeEach(() => {
  stored = [];
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
      case "automation_agent_list":
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

test("Automations arrange their own entrance: the heading, then the label and each starter, a stagger step apart", async () => {
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
  expect(arrivals.map((each) => each.textContent)).toEqual([
    expect.stringContaining("Let agents act on tickets for you"),
    "Start from an example",
    expect.stringContaining("Triage tagged tickets"),
    expect.stringContaining("Verify what is ready for testing"),
    expect.stringContaining("Weekly summary"),
  ]);
  expect(
    arrivals.map((each) => each.style.getPropertyValue("--enter-step")),
  ).toEqual(["0", "1", "2", "3", "4"]);
  expect(within(examples).getAllByRole("button")).toHaveLength(3);
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
