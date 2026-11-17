// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { StatusLineRegion } from "@/components/ui/status-line";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";
import { PlanFlow } from "./PlanFlow";
import { PlanList } from "./PlanList";

// Opening Plans and a Plan's Flow (DESIGN.md section 12): the header, then each
// card fades up from a soft blur in turn; the Flow's lanes arrive left to
// right and its lines draw once both ends are in place. Timing comes from the
// tokens, so these tests apply the real ones.

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

function reduce() {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
}

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

test("opening Plans fades up the header, then each card, from a soft blur", async () => {
  const { container } = list();
  const [header, ...cards] = appears(container);
  expect(header?.querySelector('[data-slot="page-header"]')).not.toBeNull();
  expect(cards.map((card) => card.textContent)).toEqual([
    expect.stringContaining("Launch"),
    expect.stringContaining("Docs"),
  ]);
  for (const each of [header!, ...cards]) {
    expect(each.style.opacity).toBe("0");
    expect(each.style.filter).toBe("blur(4px)");
  }
  await waitFor(() =>
    expect(appears(container).map((each) => each.style.opacity)).toEqual([
      "1",
      "1",
      "1",
    ]),
  );
});

test("Plans open without a rise or blur under reduced motion", () => {
  reduce();
  const { container } = list();
  for (const each of appears(container)) {
    expect(each.style.transform).not.toContain("6px");
    expect(each.style.filter).not.toContain("4px");
  }
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
