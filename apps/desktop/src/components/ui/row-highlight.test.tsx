// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { visualElementStore } from "motion/react";
import { afterEach, beforeAll, expect, test } from "vitest";
import { MotionProvider } from "./motion";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./select";
import { Command, CommandInput, CommandItem, CommandList } from "./command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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

test("a menu row with an icon keeps the icon as its first child, so the reason indents under the label", async () => {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled reason="Offline">
          <svg data-testid="icon" />
          Sync
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const row = await screen.findByRole("menuitem", { name: /Sync/ });
  // styles.css indents the reason with `:has(> svg:first-child)`.
  expect(row.firstElementChild).toBe(screen.getByTestId("icon"));
});

test("a sub-menu trigger is positioned, so its highlight fills only its own row", async () => {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const trigger = await screen.findByRole("menuitem", { name: "More" });
  expect(trigger.classList.contains("relative")).toBe(true);
});

// The Glide measures its old row against any scrolled ancestor that is marked
// `layoutScroll`; without it the highlight starts off its old row once the list
// has scrolled.
const marksScroll = (element: Element | null) =>
  visualElementStore.get(element as HTMLElement)?.projection?.options
    .layoutScroll === true;

test("every list that scrolls its rows is a layoutScroll host", async () => {
  render(
    <MotionProvider>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Inner</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <Select open>
        <SelectTrigger>Pick</SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
      <Command>
        <CommandList>
          <CommandItem value="one">One</CommandItem>
        </CommandList>
      </Command>
    </MotionProvider>,
  );
  await screen.findByText("Inner");
  for (const slot of [
    "dropdown-menu-content",
    "dropdown-menu-sub-content",
    "select-content",
    "command-list",
  ]) {
    const host = document.querySelector(`[data-slot="${slot}"]`);
    expect(host, slot).not.toBeNull();
    expect(marksScroll(host), slot).toBe(true);
  }
  // Select scrolls in its viewport.
  expect(
    marksScroll(document.querySelector("[data-radix-select-viewport]")),
  ).toBe(true);
});
