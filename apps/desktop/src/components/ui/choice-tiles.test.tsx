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

test("a plain tile can lead with an icon tile, and the radio still leads the title row", () => {
  render(
    <ChoiceTiles aria-label="Where" value="a" onValueChange={() => {}}>
      <ChoiceTile
        value="a"
        title="Local"
        icon={<i data-testid="icon" />}
        description="Here."
      />
      <ChoiceTile value="b" title="Remote" />
    </ChoiceTiles>,
  );
  const local = tile("Local");
  const icon = local.querySelector('[data-slot="choice-tile-icon"]');
  const radio = local.querySelector('[data-slot="choice-tile-radio"]');
  expect(icon?.contains(screen.getByTestId("icon"))).toBe(true);
  // P11: the radio sits before the title, never at the far end of the icon row.
  expect(radio?.nextElementSibling?.textContent).toContain("Local");
  expect(icon?.parentElement).not.toBe(radio?.parentElement);
  expect(local.getAttribute("aria-checked")).toBe("true");
  expect(tile("Remote").querySelector('[data-slot="choice-tile-icon"]')).toBe(
    null,
  );
});
