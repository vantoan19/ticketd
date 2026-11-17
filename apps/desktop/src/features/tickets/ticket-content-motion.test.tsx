// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";
import { ReferenceRow } from "./ReferenceRow";
import { TicketProperties } from "./TicketProperties";

// The ticket's content motion (DESIGN.md section 12): the status label
// crossfades, tags and linked tickets arrive and leave, with their neighbours
// gliding. Time is real here (see components/ui/motion.test.tsx).

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const EXIT_MS = 150;

let restoreTokens: () => void;
beforeEach(() => {
  bridge.invoke.mockResolvedValue([]);
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  bridge.invoke.mockReset();
});

function useReducedMotion() {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
}

type Ticket = ComponentProps<typeof TicketProperties>["ticket"];
const ticket = (changes: Partial<Ticket>): Ticket => ({
  id: "1",
  reference: "T-KQ1",
  title: "Ticket",
  body: "",
  status: "Todo",
  tags: [],
  project_id: null,
  plan_id: null,
  trashed: false,
  availability: null,
  parent: null,
  children: [],
  prerequisites: [],
  ...changes,
});

function Properties({
  value,
  layout = "rail",
}: {
  value: Ticket;
  layout?: "rail" | "strip";
}) {
  return (
    <MotionProvider>
      <TicketProperties
        ticket={value}
        projects={[]}
        plans={[]}
        layout={layout}
        onSaved={() => {}}
        refresh={async () => {}}
      />
    </MotionProvider>
  );
}

async function leaves(text: string): Promise<number> {
  const start = performance.now();
  await waitFor(() => expect(screen.queryByText(text)).toBeNull(), {
    interval: 4,
  });
  return performance.now() - start;
}

test("the status label crossfades: the old words fade out as the new fade in", async () => {
  const { rerender } = render(<Properties value={ticket({})} />);
  rerender(<Properties value={ticket({ status: "Done" })} />);
  expect(screen.queryByText("Todo")).not.toBeNull();
  expect(screen.queryByText("Done")).not.toBeNull();
  expect(await leaves("Todo")).toBeGreaterThanOrEqual(EXIT_MS - 10);
});

test("the status label swaps at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(<Properties value={ticket({})} />);
  rerender(<Properties value={ticket({ status: "Done" })} />);
  expect(await leaves("Todo")).toBeLessThan(EXIT_MS - 10);
});

test("a project and a Plan crossfade their labels in the folded strip", async () => {
  const { rerender } = render(
    <Properties value={ticket({ project_id: "alpha" })} layout="strip" />,
  );
  rerender(
    <Properties value={ticket({ project_id: "beta" })} layout="strip" />,
  );
  expect(screen.queryByText("alpha")).not.toBeNull();
  expect(screen.queryByText("beta")).not.toBeNull();
  await leaves("alpha");
});

test("an added tag fades up from a soft blur at 94% scale; the others do not animate", () => {
  const { rerender } = render(<Properties value={ticket({ tags: ["api"] })} />);
  const present = screen.getByText("api").closest("span[style]");
  expect(present?.getAttribute("style") ?? "").not.toContain("opacity: 0");
  rerender(<Properties value={ticket({ tags: ["api", "perf"] })} />);
  const added = screen.getByText("perf").parentElement!;
  expect(added.style.opacity).toBe("0");
  expect(added.style.transform).toContain("scale(0.94)");
  expect(added.style.filter).toBe("blur(4px)");
});

test("an added tag settles into place", async () => {
  const { rerender } = render(<Properties value={ticket({ tags: ["api"] })} />);
  rerender(<Properties value={ticket({ tags: ["api", "perf"] })} />);
  const added = screen.getByText("perf").parentElement!;
  await waitFor(() => expect(added.style.opacity).toBe("1"));
});

test("a removed tag fades out in its own time and leaves", async () => {
  const { rerender } = render(
    <Properties value={ticket({ tags: ["api", "perf"] })} />,
  );
  rerender(<Properties value={ticket({ tags: ["api"] })} />);
  expect(screen.queryByText("perf")).not.toBeNull();
  expect(await leaves("perf")).toBeGreaterThanOrEqual(EXIT_MS - 10);
  expect(screen.queryByText("api")).not.toBeNull();
});

test("a removed tag leaves at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(
    <Properties value={ticket({ tags: ["api", "perf"] })} />,
  );
  rerender(<Properties value={ticket({ tags: ["api"] })} />);
  expect(await leaves("perf")).toBeLessThan(EXIT_MS - 10);
});

test("the last tag fades out before 'No tags' is the whole value", async () => {
  const { rerender } = render(<Properties value={ticket({ tags: ["api"] })} />);
  rerender(<Properties value={ticket({ tags: [] })} />);
  expect(screen.queryByText("No tags")).not.toBeNull();
  await leaves("api");
});

function Linked({ references }: { references: string[] }) {
  return (
    <MotionProvider>
      <ul>
        <Presence initial={false} mode="popLayout">
          {references.map((reference) => (
            <ReferenceRow
              key={reference}
              animated
              reference={reference}
              title={`Title of ${reference}`}
              status="Todo"
              caption="Todo"
              density="rail"
              onOpen={() => {}}
            />
          ))}
        </Presence>
      </ul>
    </MotionProvider>
  );
}

test("a linked ticket fades up when added, and the rows already there stay still", () => {
  const { rerender } = render(<Linked references={["T-AAA"]} />);
  expect(screen.getByText("T-AAA").closest("li")!.style.opacity).toBe("1");
  rerender(<Linked references={["T-AAA", "T-BBB"]} />);
  const added = screen.getByText("T-BBB").closest("li")!;
  expect(added.style.opacity).toBe("0");
  expect(added.style.filter).toBe("blur(4px)");
});

test("a removed linked ticket fades out in its own time", async () => {
  const { rerender } = render(<Linked references={["T-AAA", "T-BBB"]} />);
  rerender(<Linked references={["T-AAA"]} />);
  expect(screen.queryByText("T-BBB")).not.toBeNull();
  expect(await leaves("T-BBB")).toBeGreaterThanOrEqual(EXIT_MS - 10);
});
