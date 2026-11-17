// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Disclosure } from "@/components/ui/disclosure";
import { MotionProvider } from "@/components/ui/motion";
import {
  CommentRow,
  EventGroup,
  EventRow,
  Timeline,
} from "@/components/ui/timeline";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

// Expanding and collapsing, and a new update arriving (DESIGN.md section 12).
// Time is real here (see motion.test.tsx): a motion never ends sooner than its
// duration, which is the bound these tests rely on.

const EXIT_MS = 150;

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
});

function useReducedMotion() {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
}

function holdKey() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", repeat: true }),
    );
  });
}

async function leaves(text: string): Promise<number> {
  const start = performance.now();
  await waitFor(() => expect(screen.queryByText(text)).toBeNull(), {
    interval: 4,
  });
  return performance.now() - start;
}

function Group() {
  return (
    <MotionProvider>
      <Timeline aria-label="Activity">
        <EventGroup icon={Bell} summary="2 changes" time="now">
          <EventRow icon={Bell}>Status changed</EventRow>
          <EventRow icon={Bell}>Tag added</EventRow>
        </EventGroup>
      </Timeline>
    </MotionProvider>
  );
}

const toggle = () => screen.getByRole("button", { name: /2 changes/ });
const region = (container: HTMLElement) =>
  container.querySelector('[data-slot="expand"]');

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

it("closing a group fades its rows out while the height closes", async () => {
  const { container } = render(<Group />);
  fireEvent.click(toggle());
  await waitFor(() =>
    expect(screen.getByText("Tag added").closest("li")?.style.opacity).toBe(
      "1",
    ),
  );
  // Two clicks inside 350ms are rapid, and land instantly; wait that out.
  await new Promise((resolve) => setTimeout(resolve, 380));
  fireEvent.click(toggle());
  expect(region(container)?.getAttribute("data-open")).toBe("false");
  expect(screen.queryByText("Status changed")).not.toBeNull();
  expect(await leaves("Status changed")).toBeGreaterThanOrEqual(EXIT_MS - 10);
});

it("a group's rows leave at once under reduced motion", async () => {
  useReducedMotion();
  render(<Group />);
  fireEvent.click(toggle());
  fireEvent.click(toggle());
  expect(await leaves("Status changed")).toBeLessThan(EXIT_MS - 10);
});

it("a group's rows leave at once while a key repeats", async () => {
  render(<Group />);
  fireEvent.click(toggle());
  holdKey();
  fireEvent.click(toggle());
  expect(await leaves("Status changed")).toBeLessThan(EXIT_MS - 10);
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
  await waitFor(() => expect(added.style.opacity).toBe("1"));
});
