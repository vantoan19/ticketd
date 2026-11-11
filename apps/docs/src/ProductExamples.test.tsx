import { afterEach, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  WorkExample,
  AgentUpdateExample,
  AssistantExample,
} from "./ProductExamples";

afterEach(cleanup);

test("selecting work reveals its context and preserves the shared spec relationship", () => {
  render(<WorkExample />);
  const ticket = within(
    screen.getByRole("article", { name: "Selected ticket" }),
  );
  expect(ticket.getByText(/One spec, shared by T-12 and T-13/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /T-13/ }));
  expect(ticket.getByRole("heading", { name: /Alert on-call/ })).toBeTruthy();
  expect(ticket.getByText("Blocked by T-12")).toBeTruthy();
  expect(
    ticket.getByRole("heading", { name: /Login hardening spec/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /T-14/ }));
  expect(
    ticket.getByRole("heading", { name: /Login form design/ }),
  ).toBeTruthy();
  expect(ticket.queryByText(/One spec, shared/)).toBeNull();
  expect(
    screen.getByRole("button", { name: /T-14/ }).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("agent evidence can be inspected and work completes only on explicit review", () => {
  render(<AgentUpdateExample />);
  expect(screen.getByText("In review")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Pull request #87/ }));
  expect(
    screen.getByRole("region", { name: "Review evidence" }).textContent,
  ).toContain("Retry-After");
  expect(screen.queryByText("Done")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
  expect(screen.getByText("Done")).toBeTruthy();
  expect(screen.getByText(/T-13 is ready to start/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset example" }));
  expect(screen.getByText("In review")).toBeTruthy();
  expect(screen.queryByText("PAWPROVED")).toBeNull();
  expect(screen.queryByRole("region", { name: "Review evidence" })).toBeNull();
});

test("assistant sources match the selected question and close when the question changes", () => {
  render(<AssistantExample />);
  fireEvent.click(screen.getByRole("button", { name: /Latest agent update/ }));
  expect(
    screen.getByRole("blockquote", { name: "Latest agent update" }).textContent,
  ).toContain("Limiter tests pass on CI");
  fireEvent.click(
    screen.getByRole("button", { name: "Why limit by account and IP?" }),
  );
  expect(screen.queryByRole("blockquote")).toBeNull();
  expect(screen.getByText(/The investigation found attempts/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Login abuse notes/ }));
  expect(screen.getByRole("blockquote").textContent).toContain(
    "Avoid a permanent lockout",
  );
  fireEvent.click(screen.getByRole("button", { name: /Login abuse notes/ }));
  expect(screen.queryByRole("blockquote")).toBeNull();
});

test("an assistant draft can be discarded and is added only after confirmation", () => {
  render(<AssistantExample />);
  fireEvent.click(
    screen.getByRole("button", { name: /Draft a review ticket/ }),
  );
  expect(screen.getByRole("region", { name: "Proposed ticket" })).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Add to Plan" }),
  );
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("region", { name: "Proposed ticket" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /Draft a review ticket/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Draft a review ticket/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to Plan" }));
  expect(screen.getByRole("status").textContent).toContain(
    "T-18 added to Login hardening",
  );
  expect(screen.queryByRole("button", { name: "Add to Plan" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reset example" }));
  expect(screen.queryByRole("status")).toBeNull();
});
