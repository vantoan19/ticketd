// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, expect, it, vi } from "vitest";
import { Disclosure } from "@/components/ui/disclosure";
import { MotionProvider } from "@/components/ui/motion";
import {
  CommentRow,
  EventGroup,
  EventRow,
  Timeline,
} from "@/components/ui/timeline";
import { frames } from "@/test/motion-clock";
import {
  EXIT_MS,
  holdKey,
  motionTestbed,
  SETTLED_MS,
} from "@/test/motion-testbed";

// Expanding and collapsing, and a new update arriving (DESIGN.md section 12).
// Time is the test's own (test/motion-clock), so nothing depends on how fast
// the machine runs.

const STAGGER_MS = 24;
const testbed = motionTestbed();
afterEach(() => vi.restoreAllMocks());

function Group({ extra = 0 }: { extra?: number }) {
  return (
    <MotionProvider>
      <Timeline aria-label="Activity">
        <EventGroup icon={Bell} summary="2 changes" time="now">
          <EventRow icon={Bell}>Status changed</EventRow>
          <EventRow icon={Bell}>Tag added</EventRow>
          {Array.from({ length: extra }, (_, i) => (
            <EventRow key={i} icon={Bell}>
              {`Extra ${i}`}
            </EventRow>
          ))}
        </EventGroup>
      </Timeline>
    </MotionProvider>
  );
}

const toggle = () => screen.getByRole("button", { name: /2 changes/ });
const region = (container: HTMLElement) =>
  container.querySelector('[data-slot="expand"]');

/** Two clicks inside 350ms are rapid and land instantly: space them out. */
function spaceClicks() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return () => {
    now += 400;
  };
}

it("a folded group opens its rows, and its closed region is inert", () => {
  const { container } = render(<Group />);
  expect(screen.queryByText("Status changed")).toBeNull();
  expect(region(container)?.hasAttribute("inert")).toBe(true);
  fireEvent.click(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(region(container)?.hasAttribute("inert")).toBe(false);
  expect(screen.getByText("Status changed")).toBeTruthy();
  expect(screen.getByText("Tag added")).toBeTruthy();
});

it("a group's rows start soft and fade up one after another", () => {
  render(<Group />);
  fireEvent.click(toggle());
  const first = screen.getByText("Status changed").closest("li")!;
  const second = screen.getByText("Tag added").closest("li")!;
  expect(first.style.opacity).toBe("0");
  expect(first.style.transform).toContain("translateY(6px)");
  expect(first.style.filter).toBe("blur(4px)");
  expect(second.style.opacity).toBe("0");
});

it("a group's rows wait their stagger step, in every property", async () => {
  render(<Group extra={6} />);
  fireEvent.click(toggle());
  const last = screen.getByText("Extra 5").closest("li")!;
  const first = screen.getByText("Status changed").closest("li")!;
  await frames();
  // The eighth row waits seven steps; short of that it has not started.
  await testbed.advance(7 * STAGGER_MS - 10);
  expect(last.style.opacity).toBe("0");
  expect(last.style.filter).toBe("blur(4px)");
  expect(Number(first.style.opacity)).toBeGreaterThan(0);
  await testbed.advance(SETTLED_MS);
  expect(last.style.opacity).toBe("1");
});

it("closing a group fades its rows out while the height closes", async () => {
  const later = spaceClicks();
  const { container } = render(<Group />);
  fireEvent.click(toggle());
  await frames();
  await testbed.advance(SETTLED_MS);
  later();
  fireEvent.click(toggle());
  expect(region(container)?.getAttribute("data-open")).toBe("false");
  await frames();
  expect(screen.queryByText("Status changed")).not.toBeNull();
  await testbed.advance(EXIT_MS - 10);
  expect(screen.queryByText("Status changed")).not.toBeNull();
  await testbed.advance(20);
  expect(screen.queryByText("Status changed")).toBeNull();
});

it("a group's rows leave at once under reduced motion", async () => {
  testbed.reduceMotion();
  render(<Group />);
  fireEvent.click(toggle());
  fireEvent.click(toggle());
  await frames();
  expect(screen.queryByText("Status changed")).toBeNull();
});

it("a group's rows leave at once while a key repeats", async () => {
  render(<Group />);
  fireEvent.click(toggle());
  holdKey();
  fireEvent.click(toggle());
  await frames();
  expect(screen.queryByText("Status changed")).toBeNull();
});

it("a Disclosure keeps its closed content mounted but inert, and opens it", () => {
  const { container } = render(
    <Disclosure label="Details">
      <p>Inside</p>
    </Disclosure>,
  );
  const button = screen.getByRole("button", { name: /Details/ });
  expect(screen.queryByText("Inside")).not.toBeNull();
  expect(region(container)?.hasAttribute("inert")).toBe(true);
  expect(
    document.getElementById(button.getAttribute("aria-controls")!),
  ).not.toBeNull();
  fireEvent.click(button);
  expect(region(container)?.hasAttribute("inert")).toBe(false);
  expect(region(container)?.getAttribute("data-open")).toBe("true");
});

function Updates({ arriving }: { arriving: boolean }) {
  return (
    <MotionProvider>
      <Timeline aria-label="Activity">
        <CommentRow
          icon={Bell}
          header="You"
          label="Update by you"
          arriving={arriving}
        >
          New update
        </CommentRow>
        <CommentRow icon={Bell} header="Agent" label="Update by agent">
          Earlier update
        </CommentRow>
      </Timeline>
    </MotionProvider>
  );
}

it("an arriving update fades up from a soft blur and the others stay as they are", () => {
  render(<Updates arriving />);
  const added = screen.getByText("New update").closest("li")!;
  expect(added.style.opacity).toBe("0");
  expect(added.style.transform).toContain("translateY(6px)");
  expect(added.style.filter).toBe("blur(4px)");
  expect(screen.getByText("Earlier update").closest("li")!.style.opacity).toBe(
    "",
  );
});

it("an update that is not arriving shows without motion", () => {
  render(<Updates arriving={false} />);
  expect(screen.getByText("New update").closest("li")!.style.opacity).toBe("");
});

it("an arriving update settles into place", async () => {
  render(<Updates arriving />);
  const added = screen.getByText("New update").closest("li")!;
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(added.style.opacity).toBe("1");
});
