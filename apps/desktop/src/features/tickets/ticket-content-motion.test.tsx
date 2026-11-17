// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { frames } from "@/test/motion-clock";
import { EXIT_MS, motionTestbed, SETTLED_MS } from "@/test/motion-testbed";
import { ReferenceRow } from "./ReferenceRow";
import { TicketProperties } from "./TicketProperties";

// The ticket's content motion (DESIGN.md section 12): the status label
// crossfades, tags and linked tickets arrive and leave, with their neighbours
// gliding. Time is the test's own (test/motion-clock).

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const testbed = motionTestbed();
beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invoke.mockResolvedValue([]);
});

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

/** Whether the text is still in the document after `ms` of motion time. */
async function presentAfter(text: string, ms: number): Promise<boolean> {
  await frames();
  await testbed.advance(ms);
  return screen.queryByText(text) !== null;
}

test("the status label crossfades: the old words fade out as the new fade in", async () => {
  const { rerender } = render(<Properties value={ticket({})} />);
  rerender(<Properties value={ticket({ status: "Done" })} />);
  expect(screen.queryByText("Todo")).not.toBeNull();
  expect(screen.queryByText("Done")).not.toBeNull();
  expect(await presentAfter("Todo", EXIT_MS - 10)).toBe(true);
  expect(await presentAfter("Todo", 20)).toBe(false);
});

test("the status label swaps at once under reduced motion", async () => {
  testbed.reduceMotion();
  const { rerender } = render(<Properties value={ticket({})} />);
  rerender(<Properties value={ticket({ status: "Done" })} />);
  await frames();
  expect(screen.queryByText("Todo")).toBeNull();
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
  expect(await presentAfter("alpha", SETTLED_MS)).toBe(false);
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
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(added.style.opacity).toBe("1");
});

test("a removed tag fades out in its own time and leaves", async () => {
  const { rerender } = render(
    <Properties value={ticket({ tags: ["api", "perf"] })} />,
  );
  rerender(<Properties value={ticket({ tags: ["api"] })} />);
  expect(screen.queryByText("perf")).not.toBeNull();
  expect(await presentAfter("perf", EXIT_MS - 10)).toBe(true);
  expect(await presentAfter("perf", 20)).toBe(false);
  expect(screen.queryByText("api")).not.toBeNull();
});

test("a removed tag leaves at once under reduced motion", async () => {
  testbed.reduceMotion();
  const { rerender } = render(
    <Properties value={ticket({ tags: ["api", "perf"] })} />,
  );
  rerender(<Properties value={ticket({ tags: ["api"] })} />);
  await frames();
  expect(screen.queryByText("perf")).toBeNull();
});

test("the last tag fades out before 'No tags' is the whole value", async () => {
  const { rerender } = render(<Properties value={ticket({ tags: ["api"] })} />);
  rerender(<Properties value={ticket({ tags: [] })} />);
  expect(screen.queryByText("No tags")).not.toBeNull();
  expect(await presentAfter("api", SETTLED_MS)).toBe(false);
});

test("'No tags' is plain words: only a pill makes the tags row a pill row", async () => {
  // The pill-row padding is keyed on a child of .rail-tags (properties.css).
  const pills = () => document.querySelectorAll(".rail-tags > *").length;
  const { rerender } = render(<Properties value={ticket({})} />);
  expect(pills()).toBe(0);
  rerender(<Properties value={ticket({ tags: ["api"] })} />);
  expect(pills()).toBe(1);
  rerender(<Properties value={ticket({ tags: [] })} />);
  // Still a pill row while the last pill fades, then plain words.
  expect(pills()).toBe(1);
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(pills()).toBe(0);
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
  expect(await presentAfter("T-BBB", EXIT_MS - 10)).toBe(true);
  expect(await presentAfter("T-BBB", 20)).toBe(false);
});
