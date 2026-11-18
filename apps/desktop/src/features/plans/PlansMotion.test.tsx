// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { StatusLineRegion } from "@/components/ui/status-line";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { PlanFlow } from "./PlanFlow";
import { PlanList } from "./PlanList";

// Opening Plans and a Plan's Flow (DESIGN.md section 12): the header, then each
// card fades up from a soft blur in turn (CSS, enter.css, so these tests check
// the markers it plays from); the Flow's lanes arrive left to right and its
// lines draw once both ends are in place. Timing comes from the tokens, so
// these tests apply the real ones.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const prerequisite = (reference: string) => ({
  reference,
  title: reference,
  status: "Todo",
  trashed: false,
  unresolved: true,
});
const ticket = (reference: string, blockers: string[] = []) => ({
  reference,
  title: `${reference} title`,
  status: "Todo",
  availability: blockers.length ? "Blocked" : "Ready",
  prerequisites: blockers.map(prerequisite),
});
vi.mock("./plan-members", () => ({
  PlanMemberWindow: class extends Error {},
  flowPlanMembers: async () => [
    ticket("T-A1"),
    ticket("T-B1", ["T-A1"]),
    ticket("T-C1", ["T-B1"]),
  ],
}));

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  bridge.invoke.mockResolvedValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const plans = [
  { id: "p1", name: "Launch", archived: false, purpose: "" },
  { id: "p2", name: "Docs", archived: false, purpose: "" },
];
function list() {
  return render(
    <MotionProvider>
      <TooltipProvider>
        <StatusLineRegion>
          <PlanList
            plans={plans}
            archived={false}
            onOpen={() => {}}
            onArchivedChange={() => {}}
            refresh={async () => {}}
          />
        </StatusLineRegion>
      </TooltipProvider>
    </MotionProvider>,
  );
}
const appears = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="appear"]'),
];

const steps = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>("[data-enter]"),
];

test("Plans arrange their own entrance: the header, then each card, a stagger step apart", () => {
  const { container } = list();
  expect(
    container
      .querySelector('[data-slot="management-page"]')
      ?.hasAttribute("data-own-entrance"),
  ).toBe(true);
  const [header, ...cards] = steps(container);
  expect(header?.querySelector('[data-slot="page-header"]')).not.toBeNull();
  expect(cards.map((card) => card.textContent)).toEqual([
    expect.stringContaining("Launch"),
    expect.stringContaining("Docs"),
  ]);
  expect(
    steps(container).map((each) => each.style.getPropertyValue("--enter-step")),
  ).toEqual(["0", "1", "2"]);
});

test("each card's progress bar waits for its own card, not a flat delay", () => {
  // The bar's delay is its card's step plus the entrance (plan-progress.css),
  // so the bar has to sit inside the element that holds the card's step.
  const css = readFileSync(join(__dirname, "plan-progress.css"), "utf8");
  expect(css).toMatch(
    /animation-delay:\s*calc\(\s*var\(--stagger\)\s*\*\s*min\(var\(--enter-step, 0\), 7\)\s*\+\s*var\(--dur-enter\)/,
  );
  const { container } = list();
  for (const bar of container.querySelectorAll(".plan-split-bar"))
    expect(bar.closest("[data-enter]")?.textContent).toMatch(/Launch|Docs/);
});

test("the Flow's edge-draw timing is named, not a bare multiplier", () => {
  const css = readFileSync(join(__dirname, "plan-flow.css"), "utf8");
  expect(css).toContain("--edge-wait-entrances: 2;");
  expect(css).toContain("--edge-draw-entrances: 1.75;");
  expect(css).not.toMatch(/calc\(var\(--dur-enter\) \* [\d.]+\)/);
});

function flow() {
  return render(
    <MotionProvider>
      <TooltipProvider>
        <PlanFlow id="p1" revision={0} onOpen={() => {}} />
      </TooltipProvider>
    </MotionProvider>,
  );
}
/** Cards one lane apart, so a line runs from each blocker to its dependent. */
function placeLanes() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const reference = this.getAttribute("aria-label")?.split(" ")[0];
      const lane = reference === "T-B1" ? 1 : reference === "T-C1" ? 2 : 0;
      const x = lane * 344;
      return {
        x,
        y: 0,
        left: x,
        right: x + 296,
        top: 0,
        bottom: 86,
        width: 296,
        height: 86,
        toJSON: () => ({}),
      };
    },
  );
}

test("a Flow's lane headings and tickets arrive in turn, left to right", async () => {
  const { container } = flow();
  await screen.findByRole("button", { name: /T-A1/ });
  const arrivals = appears(container).map((each) => each.textContent);
  expect(arrivals).toEqual([
    expect.stringContaining("Now"),
    expect.stringContaining("T-A1"),
    expect.stringContaining("Next"),
    expect.stringContaining("T-B1"),
    expect.stringContaining("Later"),
    expect.stringContaining("T-C1"),
  ]);
});

test("a Flow's dependency lines draw along their length once the cards are in", async () => {
  placeLanes();
  const { container } = flow();
  await screen.findByRole("button", { name: /T-A1/ });
  await waitFor(() =>
    expect(container.querySelectorAll("path[data-edge]")).toHaveLength(2),
  );
  for (const line of container.querySelectorAll("path[data-edge]")) {
    expect(line.getAttribute("data-slot")).toBe("drawn-path");
    expect(line.getAttribute("pathLength")).toBe("1");
  }
});

test("a line is measured again when a card lands, so it ends where the card is", async () => {
  placeLanes();
  const { container } = flow();
  await screen.findByRole("button", { name: /T-A1/ });
  await waitFor(() =>
    expect(container.querySelectorAll("path[data-edge]")).toHaveLength(2),
  );
  const before = container.querySelector("path[data-edge]")!.getAttribute("d");
  // The first lane's card was painted low while it rose; it lands 6px higher.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const lane = this.getAttribute("aria-label")?.startsWith("T-B1") ? 1 : 0;
      return {
        x: lane * 344,
        y: 0,
        left: lane * 344,
        right: lane * 344 + 296,
        top: lane ? 0 : -6,
        bottom: 86,
        width: 296,
        height: 86,
        toJSON: () => ({}),
      };
    },
  );
  await waitFor(() =>
    expect(
      container.querySelector("path[data-edge]")!.getAttribute("d"),
    ).not.toBe(before),
  );
});

test("a lane's panel arrives with its heading, on the heading's step, not before it", async () => {
  const { container } = flow();
  await screen.findByRole("button", { name: /T-A1/ });
  const lanes = [
    ...container.querySelectorAll<HTMLElement>(".ui-graph-flow-lane"),
  ];
  // The heading's `Appear` takes the same index, three steps a lane.
  expect(
    lanes.map((lane) => lane.style.getPropertyValue("--enter-step")),
  ).toEqual(["0", "3", "6"]);
  // jsdom cannot paint a panel, so the rule is read as written: the well fades
  // in from transparent over the entrance, held until its step.
  const css = readFileSync(join(__dirname, "plan-flow.css"), "utf8");
  expect(css).toMatch(
    /@keyframes plan-flow-lane-in\s*\{\s*from\s*\{\s*background-color:\s*transparent/,
  );
  expect(css).toMatch(
    /\.plan-flow-lanes > \.ui-graph-flow-lane\s*\{\s*animation:\s*plan-flow-lane-in var\(--dur-enter\) var\(--ease-out\) backwards;\s*animation-delay:\s*calc\(var\(--stagger\) \* min\(var\(--enter-step, 0\), 7\)\)/,
  );
});
