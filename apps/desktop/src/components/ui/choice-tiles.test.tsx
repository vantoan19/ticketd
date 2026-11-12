// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ChoiceTile, ChoiceTiles } from "./choice-tiles";

afterEach(cleanup);

function Harness({ disabledValue }: { disabledValue?: string }) {
  const [value, setValue] = useState("split");
  return (
    <ChoiceTiles
      aria-label="Open tickets"
      value={value}
      onValueChange={setValue}
    >
      <ChoiceTile
        value="split"
        title="Beside the list"
        description="Split view."
        preview={<i data-testid="preview" />}
      />
      <ChoiceTile
        value="full"
        title="Full width"
        description="Expanded view."
        disabled={disabledValue === "full"}
      >
        <span>Extra</span>
      </ChoiceTile>
    </ChoiceTiles>
  );
}

const tile = (name: string) =>
  screen.getByRole("radio", { name: new RegExp(name) });

test("a tile is a radio named by its title and description, with its preview and extra content", () => {
  render(<Harness />);
  expect(tile("Beside the list").getAttribute("aria-checked")).toBe("true");
  expect(tile("Beside the list").textContent).toContain("Split view.");
  expect(tile("Beside the list").contains(screen.getByTestId("preview"))).toBe(
    true,
  );
  expect(tile("Full width").textContent).toContain("Extra");
});

test("choosing a tile selects it and unselects the other", () => {
  render(<Harness />);
  fireEvent.click(tile("Full width"));
  expect(tile("Full width").getAttribute("aria-checked")).toBe("true");
  expect(tile("Beside the list").getAttribute("aria-checked")).toBe("false");
});

test("a disabled tile cannot be chosen", () => {
  render(<Harness disabledValue="full" />);
  fireEvent.click(tile("Full width"));
  expect(tile("Full width").getAttribute("aria-checked")).toBe("false");
  expect((tile("Full width") as HTMLButtonElement).disabled).toBe(true);
});
