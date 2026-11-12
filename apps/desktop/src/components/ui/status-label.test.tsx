// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StatusLabel } from "./status-label";

afterEach(cleanup);

test("shows the word with a dot in the given tone, in the caption size on request", () => {
  const { container } = render(
    <StatusLabel tone="checked" size="caption">
      Checked
    </StatusLabel>,
  );
  const label = screen.getByText("Checked");
  expect(label.getAttribute("data-slot")).toBe("status-label");
  expect(label.className).toContain("text-xs");
  expect(
    container
      .querySelector("[data-slot=status-dot]")
      ?.getAttribute("data-tone"),
  ).toBe("checked");
});

test("defaults to the interface size", () => {
  render(<StatusLabel tone="attention">Not found</StatusLabel>);
  expect(screen.getByText("Not found").className).toContain("text-sm");
});
