// @vitest-environment jsdom
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "./sheet";

beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const actualStyle = window.getComputedStyle;
  // Supply jsdom's missing animation-name signal; the browser owns duration.
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const native = actualStyle(element, pseudo);
    if (!element.hasAttribute("data-slot")) return native;
    return new Proxy(native, {
      get(target, key) {
        if (key === "animationName")
          return element.getAttribute("data-state") === "closed"
            ? "test-exit"
            : "test-enter";
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function finishExit(element: Element) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "test-exit" });
  fireEvent(element, event);
}
function Surface({ kind }: { kind: "menu" | "popover" | "sheet" }) {
  const [open, setOpen] = useState(true);
  const [clicks, setClicks] = useState(0);
  const close = <button onClick={() => setOpen(false)}>Close layer</button>;
  return (
    <>
      <input aria-label="Newer draft" />
      <button onClick={() => setClicks(clicks + 1)}>
        Underlying action {clicks}
      </button>
      {kind === "menu" ? (
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
          <DropdownMenuTrigger>Opener</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setOpen(false)}>
              Close layer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : kind === "popover" ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger>Opener</PopoverTrigger>
          <PopoverContent>
            <input aria-label="Overlay draft" />
            {close}
          </PopoverContent>
        </Popover>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger>Opener</SheetTrigger>
          <SheetContent>
            <SheetTitle>Layer</SheetTitle>
            <SheetDescription>Exit keeps its content.</SheetDescription>
            {close}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
test.each(["menu", "popover", "sheet"] as const)(
  "closing %s becomes inert and respects a newer draft through its exit",
  async (kind) => {
    const user = userEvent.setup();
    render(<Surface kind={kind} />);
    const close = await screen.findByText("Close layer");
    const content = close.closest('[data-slot$="content"]')!;
    await user.click(close);
    await waitFor(() => expect(content.hasAttribute("inert")).toBe(true), {
      timeout: 1000,
    });
    expect(content.isConnected).toBe(true);
    const input = screen.getByLabelText("Newer draft");
    input.focus();
    fireEvent.change(input, { target: { value: "Newer typing" } });
    if (kind !== "sheet") {
      await user.click(
        screen.getByRole("button", { name: "Underlying action 0" }),
      );
      input.focus();
    }
    finishExit(content);
    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    if (overlay) finishExit(overlay);
    await waitFor(() => expect(content.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input).toHaveProperty("value", "Newer typing");
    if (kind === "sheet")
      await user.click(
        screen.getByRole("button", { name: "Underlying action 0" }),
      );
    expect(
      screen.getByRole("button", { name: "Underlying action 1" }),
    ).toBeTruthy();
  },
);
test("a closing submenu leaves its parent keyboard action usable", async () => {
  const user = userEvent.setup();
  function Nested() {
    const [open, setOpen] = useState(true);
    return (
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open={open} onOpenChange={setOpen}>
            <DropdownMenuSubTrigger>Submenu</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Child action</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem>Parent action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  render(<Nested />);
  const child = await screen.findByRole("menuitem", { name: "Child action" });
  const content = child.closest('[data-slot="dropdown-menu-sub-content"]')!;
  child.focus();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(content.hasAttribute("inert")).toBe(true), {
    timeout: 1000,
  });
  const parent = screen.getByRole("menuitem", { name: "Parent action" });
  parent.focus();
  finishExit(content);
  await waitFor(() => expect(content.isConnected).toBe(false));
  expect(document.activeElement).toBe(parent);
});

test("reopening during a popover exit preserves its draft and restores interaction", async () => {
  const user = userEvent.setup();
  render(<Surface kind="popover" />);
  const draft = await screen.findByRole("textbox", { name: "Overlay draft" });
  await user.type(draft, "Kept while reopening");
  const close = screen.getByRole("button", { name: "Close layer" });
  const content = close.closest('[data-slot="popover-content"]')!;
  await user.click(close);
  await waitFor(() => expect(content.hasAttribute("inert")).toBe(true));
  await user.click(screen.getByRole("button", { name: "Opener" }));
  await waitFor(() => expect(content.hasAttribute("inert")).toBe(false));
  expect(content.isConnected).toBe(true);
  expect(screen.getByRole("textbox", { name: "Overlay draft" })).toBe(draft);
  expect(draft).toHaveProperty("value", "Kept while reopening");
  await user.click(screen.getByRole("button", { name: "Close layer" }));
  expect(content.getAttribute("data-state")).toBe("closed");
  finishExit(content);
  await waitFor(() => expect(content.isConnected).toBe(false));
});
