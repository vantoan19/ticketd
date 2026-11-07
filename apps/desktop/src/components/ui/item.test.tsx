// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Item } from "@/components/ui/item";
afterEach(cleanup);

test("an Item row keeps its children and accessible names", () => {
  render(
    <ul>
      <Item asChild>
        <li>
          <button type="button">Open T-1</button>
        </li>
      </Item>
    </ul>,
  );
  const row = screen.getByRole("listitem");
  expect(row.getAttribute("data-slot")).toBe("item");
  expect(screen.getByRole("button", { name: "Open T-1" })).toBeTruthy();
});
