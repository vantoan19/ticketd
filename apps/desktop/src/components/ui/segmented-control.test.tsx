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
import { SegmentedControl } from "./segmented-control";

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
