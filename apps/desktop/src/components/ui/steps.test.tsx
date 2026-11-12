// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Step, Steps } from "./steps";

afterEach(cleanup);

test("numbers the steps in order, marks the current one and shows an action", () => {
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
    items.map(
      (item) => item.querySelector("[data-slot=step-number]")?.textContent,
    ),
  ).toEqual(["1", "2", "3"]);
  expect(items[1]?.getAttribute("aria-current")).toBe("step");
  expect(items[0]?.getAttribute("aria-current")).toBeNull();
  expect(items[1]?.contains(screen.getByRole("link", { name: "Guide" }))).toBe(
    true,
  );
  expect(items[0]?.textContent).toContain("From the download.");
});
