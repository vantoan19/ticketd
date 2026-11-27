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
