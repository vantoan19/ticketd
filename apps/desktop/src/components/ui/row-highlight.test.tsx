// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test } from "vitest";
import { Command, CommandInput, CommandItem, CommandList } from "./command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

// The highlight of menu and list rows (DESIGN.md section 12): a Glide that
// travels with the keyboard, a plain fill that follows the pointer at once.

beforeAll(() => {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const glide = (row: HTMLElement) => row.querySelector('[data-slot="glide"]');
const fill = (row: HTMLElement) => row.querySelector('[data-slot="highlight"]');

function Menu() {
  return (
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>One</DropdownMenuItem>
        <DropdownMenuItem>Two</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

test("arrow keys carry one Glide from menu item to menu item", async () => {
  const user = userEvent.setup();
  render(<Menu />);
  await user.keyboard("{ArrowDown}");
  const one = await screen.findByRole("menuitem", { name: "One" });
  const two = screen.getByRole("menuitem", { name: "Two" });
  expect(glide(one)).not.toBeNull();
  expect(glide(two)).toBeNull();

  await user.keyboard("{ArrowDown}");
  expect(glide(one)).toBeNull();
  expect(glide(two)).not.toBeNull();
});

test("the pointer highlights a menu item with a plain fill, not a Glide", async () => {
  const user = userEvent.setup();
  render(<Menu />);
  const two = await screen.findByRole("menuitem", { name: "Two" });
  await user.hover(two);
  expect(fill(two)).not.toBeNull();
  expect(glide(two)).toBeNull();
});

function List() {
  return (
    <Command>
      <CommandInput aria-label="Search" />
      <CommandList>
        <CommandItem value="one">One</CommandItem>
        <CommandItem value="two">Two</CommandItem>
      </CommandList>
    </Command>
  );
}

test("arrow keys carry the Glide through a command list", async () => {
  const user = userEvent.setup();
  render(<List />);
  await user.click(screen.getByLabelText("Search"));
  await user.keyboard("{ArrowDown}");
  const two = screen.getByRole("option", { name: "Two" });
  expect(glide(two)).not.toBeNull();
  expect(glide(screen.getByRole("option", { name: "One" }))).toBeNull();
});

test("the pointer highlights a command row with a plain fill", async () => {
  const user = userEvent.setup();
  render(<List />);
  const two = screen.getByRole("option", { name: "Two" });
  await user.hover(two);
  expect(fill(two)).not.toBeNull();
  expect(glide(two)).toBeNull();
});
