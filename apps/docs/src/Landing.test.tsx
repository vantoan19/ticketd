import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import Landing from "./Landing";
import { links } from "./links";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("the page explains its three product benefits without opening a demo", () => {
  render(<Landing />);
  expect(screen.getAllByRole("navigation")).toHaveLength(1);
  const product = within(
    screen.getByRole("region", { name: "Tickets & context" }),
  );
  expect(product.getByText("Login hardening spec")).toBeTruthy();
  const activity = within(
    screen.getByRole("region", { name: "Agent activity" }),
  );
  expect(
    activity.getByText(/Account and IP limits are implemented/),
  ).toBeTruthy();
  expect(activity.getByText("✓ Checks passed")).toBeTruthy();
  const assistant = within(
    screen.getByRole("region", { name: "AI assistant" }),
  );
  expect(
    assistant.getByText(/The rate limiter is ready for review/),
  ).toBeTruthy();
  expect(assistant.getByRole("group", { name: "Answer sources" })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  const starts = screen.getAllByRole("link", { name: /Get started/ });
  expect(starts).toHaveLength(2);
  starts.forEach((link) =>
    expect(link.getAttribute("href")).toBe(links.install),
  );
});

test("system theme updates until overridden, without resetting selected work", () => {
  const media = new Map<
    string,
    {
      matches: boolean;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }
  >();
  vi.stubGlobal("matchMedia", (query: string) => {
    const value = {
      matches: query.includes("dark"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    media.set(query, value);
    return value;
  });
  const { container, unmount } = render(<Landing />);
  const root = container.querySelector(".st")!;
  expect(root.getAttribute("data-theme")).toBe("dark");
  const darkMedia = media.get("(prefers-color-scheme: dark)")!;
  act(() => {
    darkMedia.matches = false;
    darkMedia.addEventListener.mock.calls[0]![1]();
  });
  expect(root.getAttribute("data-theme")).toBe("light");
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Tickets in the plan" }),
    ).getByRole("button", { name: /T-14/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
  act(() => darkMedia.addEventListener.mock.calls[0]![1]());
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(
    screen.getByRole("article", { name: "Selected ticket" }).textContent,
  ).toContain("Login form design");
  unmount();
  expect(darkMedia.removeEventListener).toHaveBeenCalledWith(
    "change",
    darkMedia.addEventListener.mock.calls[0]![1],
  );
});

test("the operating system motion preference reaches the factory example", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
  render(<Landing />);
  fireEvent.click(screen.getByRole("button", { name: "See it work" }));
  expect(
    screen.getByRole("button", { name: "Approve the example" }),
  ).toBeTruthy();
});
