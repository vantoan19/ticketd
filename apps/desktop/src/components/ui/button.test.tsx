// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Button } from "@/components/ui/button";

afterEach(cleanup);

test("a busy button does nothing, but stays focusable and announces itself", () => {
  const onClick = vi.fn();
  render(
    <Button busy onClick={onClick}>
      Installing…
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Installing…" });
  // Not `disabled`: a disabled button drops focus on the page.
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("true");
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

test("a busy submit button does not submit its form", () => {
  const onSubmit = vi.fn((event: { preventDefault(): void }) =>
    event.preventDefault(),
  );
  render(
    <form onSubmit={onSubmit}>
      <Button type="submit" busy>
        Replacing…
      </Button>
    </form>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(onSubmit).not.toHaveBeenCalled();
});

test("an idle button clicks as before", () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>Install</Button>);
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("a caller's ref cleanup runs on unmount, and a ref without one still gets null", () => {
  const cleanup = vi.fn();
  const withCleanup = vi.fn(() => cleanup);
  const first = render(<Button ref={withCleanup}>One</Button>);
  expect(withCleanup).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled();
  first.unmount();
  expect(cleanup).toHaveBeenCalledTimes(1);
  // React calls the cleanup instead of the ref with null.
  expect(withCleanup).toHaveBeenCalledTimes(1);

  const plain = vi.fn();
  const second = render(<Button ref={plain}>Two</Button>);
  second.unmount();
  expect(plain).toHaveBeenLastCalledWith(null);

  const object = { current: null as HTMLButtonElement | null };
  const third = render(<Button ref={object}>Three</Button>);
  expect(object.current).not.toBeNull();
  third.unmount();
  expect(object.current).toBeNull();
});
