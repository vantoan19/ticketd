// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);
import { SectionHeader } from "@/components/ui/section-header";

it("renders the title as a heading of the requested level, then count, controls and actions in order", () => {
  render(
    <SectionHeader
      title="Evidence"
      level={2}
      count={4}
      actions={<button type="button">Add evidence</button>}
    >
      <button type="button">Mode</button>
    </SectionHeader>,
  );
  expect(
    screen.getByRole("heading", { level: 2, name: "Evidence" }),
  ).toBeTruthy();
  const order = [
    screen.getByRole("heading"),
    screen.getByText("4"),
    screen.getByRole("button", { name: "Mode" }),
    screen.getByRole("button", { name: "Add evidence" }),
  ];
  order.slice(1).forEach((node, index) => {
    expect(
      order[index]!.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

it("defaults to h3 and omits a missing count", () => {
  const { container } = render(<SectionHeader title="Activity" />);
  expect(
    screen.getByRole("heading", { level: 3, name: "Activity" }),
  ).toBeTruthy();
  expect(container.querySelector('[data-slot="count"]')).toBeNull();
});

it("marks the divided option", () => {
  const { container } = render(<SectionHeader title="Notes" divided />);
  expect(
    container
      .querySelector('[data-slot="section-header"]')
      ?.hasAttribute("data-divided"),
  ).toBe(true);
});
