// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CommandBlock } from "./command-block";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

test("marks ALL_CAPS words as placeholders and keeps the prompt out of the copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const { container } = render(
    <CommandBlock
      command="ticketd export --file PATH --project PROJECT_ID"
      copyLabel="Copy the export command"
    />,
  );
  expect(
    [...container.querySelectorAll("[data-placeholder]")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["PATH", "PROJECT_ID"]);
  fireEvent.click(
    screen.getByRole("button", { name: "Copy the export command" }),
  );
  expect((await screen.findByRole("status")).textContent).toBe("Copied");
  expect(writeText).toHaveBeenCalledWith(
    "ticketd export --file PATH --project PROJECT_ID",
  );
});
