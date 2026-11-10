import { afterEach, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  AssistantDesk,
  ConnectedWorkspace,
  ContextLibrary,
} from "./FactoryScenes";

afterEach(cleanup);

function openDetails() {
  const details = screen.getByText("View details").closest("details")!;
  fireEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(true);
}

test("context selection prepares only the chosen records and clears a stale package", () => {
  render(<ContextLibrary />);
  const spec = within(
    screen.getByRole("article", { name: "Login hardening spec" }),
  );
  expect(spec.getByText(/T-12 · Rate-limit/)).toBeTruthy();
  expect(spec.getByText(/T-13 · Alert on-call/)).toBeTruthy();
  expect(
    screen
      .getAllByRole("checkbox")
      .every((input) => !input.closest("details")!.open),
  ).toBe(true);
  openDetails();
  fireEvent.click(screen.getByRole("checkbox", { name: "Login abuse notes" }));
  fireEvent.click(screen.getByRole("button", { name: /Prepare context/ }));
  const pack = within(screen.getByRole("region", { name: "Prepared context" }));
  expect(pack.getAllByRole("listitem")).toHaveLength(3);
  expect(pack.queryByText(/Login abuse notes/)).toBeNull();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Login hardening spec" }),
  );
  expect(screen.queryByRole("region", { name: "Prepared context" })).toBeNull();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Latest agent update" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Pull request #87 & CI" }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: /Prepare context/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("assistant answers expose their sources and draft confirmation adds a ticket once", () => {
  render(<AssistantDesk />);
  fireEvent.click(
    screen.getByRole("button", { name: "Why limit by account and IP?" }),
  );
  const sources = within(screen.getByRole("group", { name: "Answer sources" }));
  fireEvent.click(sources.getByRole("button", { name: /Login abuse notes/ }));
  expect(
    screen.getByRole("article", { name: "Login abuse notes" }),
  ).toBeTruthy();
  openDetails();
  fireEvent.click(
    screen.getByRole("button", { name: /Draft a review ticket/ }),
  );
  expect(screen.queryByText(/T-18 · Review/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.queryByRole("button", { name: "Add to Plan" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Draft a review ticket/ }),
  );
  fireEvent.click(sources.getByRole("button", { name: /Login abuse notes/ }));
  expect(
    screen.getByRole("article", { name: "Login abuse notes" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add to Plan" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add to Plan" }));
  expect(screen.getAllByText("T-18 · Review login rate limiting")).toHaveLength(
    1,
  );
  expect(screen.queryByRole("button", { name: "Add to Plan" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reset example" }));
  expect(screen.queryByText(/T-18 · Review/)).toBeNull();
  expect(
    screen.getByRole("article", { name: "Latest agent update" }),
  ).toBeTruthy();
});

test("the labeled source row updates the document and the decorative archive together", () => {
  const { container } = render(<ContextLibrary />);
  const records = within(
    screen.getByRole("group", { name: "Context records" }),
  );
  fireEvent.click(records.getByRole("button", { name: /Investigation/ }));
  expect(
    screen.getByRole("article", { name: "Login abuse notes" }),
  ).toBeTruthy();
  expect(screen.getByText("THIS SOURCE IS LINKED TO T-12")).toBeTruthy();
  fireEvent.click(records.getByRole("button", { name: /Specification/ }));
  expect(
    screen.getByRole("article", { name: "Login hardening spec" }),
  ).toBeTruthy();
  expect(screen.getByText("ONE SOURCE · TWO CONNECTED TICKETS")).toBeTruthy();
  expect(container.querySelector('svg [role="button"]')).toBeNull();
});

test("the automation requires an enabled rule and resets its result when disabled", () => {
  render(<AssistantDesk />);
  openDetails();
  const trigger = screen.getByRole("button", {
    name: "Try an agent update",
  }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  const rule = screen.getByRole("checkbox", {
    name: /When a ticket needs review/,
  });
  fireEvent.click(rule);
  fireEvent.click(trigger);
  expect(screen.getByText(/Inbox · T-12 needs review/)).toBeTruthy();
  fireEvent.click(rule);
  expect(screen.queryByText(/Inbox · T-12 needs review/)).toBeNull();
  expect(trigger.disabled).toBe(true);
});

test("a local change reaches the other workspace only after sync, including a restored title", () => {
  render(<ConnectedWorkspace />);
  expect(
    screen.getAllByText("T-12 · Rate-limit failed login attempts"),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Edit title locally" }));
  expect(
    screen.getAllByText("T-12 · Rate-limit failed login attempts"),
  ).toHaveLength(1);
  expect(screen.getByText(/Saved locally · 1 change to sync/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Sync change/ }));
  expect(screen.getAllByText("T-12 · Review login rate limiting")).toHaveLength(
    2,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Restore title locally" }),
  );
  expect(screen.getAllByText("T-12 · Review login rate limiting")).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: /Sync change/ }));
  expect(
    screen.getAllByText("T-12 · Rate-limit failed login attempts"),
  ).toHaveLength(2);
});
