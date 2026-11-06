// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

test("the label closes when a dialog opens over the button and stays closed when focus returns", async () => {
  render(
    <IconButton label="Ticket actions">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  const button = screen.getByRole("button", { name: "Ticket actions" });
  button.focus();
  await screen.findByRole("tooltip");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  button.blur();
  button.focus();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("tooltip")).toBeNull();
  dialog.remove();
});
