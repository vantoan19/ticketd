// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TicketWorkspaceView } from "./TicketWorkspaceView";
import { useBulkEdit } from "./useBulkEdit";
import { useTicketWorkspace } from "./useTicketWorkspace";
import { bridgeDefault } from "@/test/bridge-defaults";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { TestReads } from "@/lib/workspace-reads/testing";

// The stacked layout follows one state (DESIGN.md section 5): the content
// panel's width once it has held still. The stylesheet stacks the panes from
// the `data-narrow` the workspace carries, so a panel that is still resizing
// (the sidebar's width spring) never flips them halfway.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

let paneWidth = 1000;
/** The pane's own observers; many components watch their own sizes too. */
const observers: { report: (width: number) => void; target?: Element }[] = [];
const resize = (width: number) => {
  paneWidth = width;
  for (const one of observers)
    if (one.target?.classList.contains("plan-workspace")) one.report(width);
};
let restoreTokens: () => void;
const scrollIntoView = Element.prototype.scrollIntoView;
const clientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => paneWidth,
  });
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = {
          report: (width) =>
            callback(
              [{ contentRect: { width } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            ),
        };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      unobserve() {}
      disconnect() {}
    },
  );
  bridge.invoke.mockImplementation(async (command: string, args?: unknown) =>
    bridgeDefault(command, args as { reference?: string }),
  );
});
afterEach(() => {
  cleanup();
  restoreTokens();
  Element.prototype.scrollIntoView = scrollIntoView;
  if (clientWidth)
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  paneWidth = 1000;
  vi.unstubAllGlobals();
  observers.length = 0;
  bridge.invoke.mockReset();
});

function Harness() {
  const workspace = useTicketWorkspace(vi.fn(), vi.fn());
  const bulk = useBulkEdit(workspace.refresh);
  return (
    <TicketWorkspaceView
      workspace={workspace}
      bulk={bulk}
      hidden={false}
      inboxTarget={null}
      onCreate={vi.fn()}
    />
  );
}
const group = () => {
  const element = document.querySelector(".ticket-workspace");
  if (!element) throw new Error("no workspace");
  return element;
};
async function setUp() {
  render(
    <TestReads>
      <Harness />
    </TestReads>,
  );
  await waitFor(() => expect(group()).toBeTruthy());
}

test("a wide pane is not narrow, and a narrow one is from its first layout", async () => {
  paneWidth = 1000;
  await setUp();
  expect(group().hasAttribute("data-narrow")).toBe(false);
  cleanup();
  paneWidth = 700;
  await setUp();
  expect(group().hasAttribute("data-narrow")).toBe(true);
});

test("the stacked layout waits for the width to hold still", async () => {
  paneWidth = 1000;
  await setUp();
  // The observer's first report is taken at once; the sweep after it is not.
  act(() => resize(1000));
  act(() => resize(900));
  act(() => resize(700));
  expect(group().hasAttribute("data-narrow")).toBe(false);
  await waitFor(() => expect(group().hasAttribute("data-narrow")).toBe(true));
  act(() => resize(1000));
  expect(group().hasAttribute("data-narrow")).toBe(true);
  await waitFor(() => expect(group().hasAttribute("data-narrow")).toBe(false));
});
