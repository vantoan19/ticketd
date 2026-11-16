// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Step, Steps } from "./steps";

afterEach(cleanup);

test("marks completed steps, numbers the remaining steps and identifies the current action", () => {
  render(
    <Steps>
      <Step title="Get it" description="From the download." state="done" />
      <Step
        title="Copy it"
        state="current"
        action={<a href="#guide">Guide</a>}
      />
      <Step title="Check again" />
    </Steps>,
  );
  const items = screen.getAllByRole("listitem");
  expect(
    items
      .slice(1)
      .map(
        (item) => item.querySelector("[data-slot=step-number]")?.textContent,
      ),
  ).toEqual(["2", "3"]);
  expect(items[0]?.textContent).toContain("Completed: Get it");
  expect(items[1]?.getAttribute("aria-current")).toBe("step");
  expect(items[0]?.getAttribute("aria-current")).toBeNull();
  expect(items[1]?.contains(screen.getByRole("link", { name: "Guide" }))).toBe(
    true,
  );
  expect(items[0]?.textContent).toContain("From the download.");
});
