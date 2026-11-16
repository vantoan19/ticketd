import { fireEvent, screen, within } from "@testing-library/react";

/** Host diagnostics belong to Details; workflows can still assert the exact cause there. */
export async function revealFailureDetails(container?: HTMLElement) {
  const scope = container ? within(container) : screen;
  const trigger = await scope.findByRole("button", { name: "Details" });
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.click(trigger);
}
