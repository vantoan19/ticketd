// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

afterEach(cleanup);

test("a notice is an alert by default and keeps a role the caller sets", () => {
  render(
    <>
      <Alert>
        <AlertDescription>Saved elsewhere.</AlertDescription>
      </Alert>
      <Alert role="status" aria-label="Updates">
        <AlertDescription>Moved to Done.</AlertDescription>
      </Alert>
    </>,
  );
  expect(screen.getByRole("alert").textContent).toBe("Saved elsewhere.");
  expect(screen.getByRole("status", { name: "Updates" })).toBeTruthy();
});

test("the attention tone puts a status dot in the title and neutral does not", () => {
  const { container } = render(
    <>
      <Alert tone="attention" role="region" aria-label="Source unavailable">
        <AlertTitle>Source unavailable</AlertTitle>
      </Alert>
      <Alert role="region" aria-label="Context">
        <AlertTitle>Outside results</AlertTitle>
      </Alert>
    </>,
  );
  const dots = container.querySelectorAll('[data-slot="status-dot"]');
  expect(dots).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Source unavailable" })).toBe(
    dots[0]?.closest('[role="region"]'),
  );
});

test("a notice offers its actions as real buttons", () => {
  render(
    <Alert tone="error">
      <AlertTitle>Couldn’t save</AlertTitle>
      <AlertDescription>The workspace is busy.</AlertDescription>
      <AlertActions>
        <button type="button">Retry</button>
      </AlertActions>
    </Alert>,
  );
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("The workspace is busy.");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
