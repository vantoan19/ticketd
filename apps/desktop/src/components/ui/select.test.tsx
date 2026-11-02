// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

afterEach(() => cleanup());

test("typing on a closed picker never commits a value; only Enter or a click does", () => {
  const onValueChange = vi.fn();
  render(
    <Select value="Todo" onValueChange={onValueChange}>
      <SelectTrigger aria-label="Status: Todo">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="Todo">Todo</SelectItem>
        <SelectItem value="Done">Done</SelectItem>
      </SelectContent>
    </Select>,
  );
  const trigger = screen.getByRole("combobox", { name: "Status: Todo" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "D" });
  fireEvent.keyDown(trigger, { key: "d" });
  expect(onValueChange).not.toHaveBeenCalled();
});
