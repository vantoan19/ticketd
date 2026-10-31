// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StatusIcon, ticketStatuses } from "./StatusIcon";

afterEach(cleanup);

test("is named by its status unless decorative", () => {
  const { rerender } = render(<StatusIcon status="In review" />);
  expect(screen.getByRole("img", { name: "In review" })).toBeTruthy();
  rerender(<StatusIcon status="In review" decorative />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(ticketStatuses).toHaveLength(5);
});
