// @vitest-environment jsdom
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MotionProvider } from "./motion";
import {
  SegmentedControl,
  SegmentedTab,
  SegmentedTabList,
} from "./segmented-control";

afterEach(cleanup);

const options = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "graph", label: "Graph", disabled: true, title: "Needs a project" },
];

function Harness({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("list");
  return (
    <SegmentedControl
      aria-label="View"
      value={value}
      options={options}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const option = (name: string) =>
  screen.getByRole("radio", { name }) as HTMLButtonElement;

test("selects another option and reports it", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.click(option("Board"));
  expect(onChange).toHaveBeenCalledWith("board");
  expect(option("Board").getAttribute("aria-checked")).toBe("true");
});

test("keeps the selection when the selected option is pressed again", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.click(option("List"));
  expect(onChange).not.toHaveBeenCalled();
  expect(option("List").getAttribute("aria-checked")).toBe("true");
});

test("arrow keys move the selection, and a disabled option shows its reason", async () => {
  render(<Harness onChange={vi.fn()} />);
  option("List").focus();
  fireEvent.keyDown(option("List"), { key: "ArrowRight" });
  await waitFor(() =>
    expect(option("Board").getAttribute("aria-checked")).toBe("true"),
  );
  expect(option("Graph").disabled).toBe(true);
  expect(option("Graph").title).toBe("Needs a project");
});

const thumbIn = (element: HTMLElement) =>
  element.querySelector('[data-slot="glide"]');

test("the selection is one highlight that moves to the chosen segment", () => {
  render(
    <MotionProvider>
      <Harness onChange={vi.fn()} />
    </MotionProvider>,
  );
  expect(document.querySelectorAll('[data-slot="glide"]')).toHaveLength(1);
  expect(thumbIn(option("List"))).not.toBeNull();
  fireEvent.click(option("Board"));
  expect(document.querySelectorAll('[data-slot="glide"]')).toHaveLength(1);
  expect(thumbIn(option("Board"))).not.toBeNull();
  expect(thumbIn(option("List"))).toBeNull();
});

test("two controls on a page keep their own highlight", () => {
  render(
    <MotionProvider>
      <Harness onChange={vi.fn()} />
      <Harness onChange={vi.fn()} />
    </MotionProvider>,
  );
  expect(document.querySelectorAll('[data-slot="glide"]')).toHaveLength(2);
});

test("a tab list moves the highlight with the selected tab", () => {
  function Tabs({ selected }: { selected: string }) {
    return (
      <MotionProvider>
        <SegmentedTabList aria-label="Mode">
          {["Ask", "Plan"].map((name) => (
            <SegmentedTab key={name} aria-selected={name === selected}>
              {name}
            </SegmentedTab>
          ))}
        </SegmentedTabList>
      </MotionProvider>
    );
  }
  const { rerender } = render(<Tabs selected="Ask" />);
  const tab = (name: string) => screen.getByRole("tab", { name });
  expect(thumbIn(tab("Ask"))).not.toBeNull();
  rerender(<Tabs selected="Plan" />);
  expect(thumbIn(tab("Plan"))).not.toBeNull();
  expect(thumbIn(tab("Ask"))).toBeNull();
});

test("plain tabs show the selection by colour alone", () => {
  render(
    <MotionProvider>
      <SegmentedTabList plain aria-label="Sections">
        <SegmentedTab aria-selected>One</SegmentedTab>
      </SegmentedTabList>
    </MotionProvider>,
  );
  expect(document.querySelector('[data-slot="glide"]')).toBeNull();
});
