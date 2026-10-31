// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { IconButton } from "@/components/ui/icon-button";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

test("an icon-only button is named by its label and explains itself on keyboard focus", async () => {
  render(
    <IconButton label="Refresh">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  const button = screen.getByRole("button", { name: "Refresh" });
  button.focus();
  expect((await screen.findByRole("tooltip")).textContent).toBe("Refresh");
});
