// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notificationClient } from "@/lib/api/notifications";
import { loadPreferences, setPreference } from "@/lib/preferences";
import { AttentionPage } from "@/features/settings/pages/AttentionPage";

vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: vi.fn(),
    requestPermission: vi.fn(),
    notify: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(notificationClient.permitted).mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const notifySwitch = () =>
  screen.getByRole("switch", { name: "Notify me when a reminder is due" });

test("the page has Following, Reminders and Inbox sections", () => {
  render(<AttentionPage onOpenInbox={() => {}} />);
  for (const name of ["Following", "Reminders", "Inbox"])
    expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
  expect(screen.getByText("Changes apply right away")).toBeTruthy();
});

test("a due reminder preview shows a generic title and the real body shape", () => {
  render(<AttentionPage onOpenInbox={() => {}} />);
  const preview = screen.getByRole("img", {
    name: /Example notification: .*T-12: reminder is due/,
  });
  expect(screen.getByText("What a due reminder looks like")).toBeTruthy();
  expect(preview.textContent).toContain("T-12: reminder is due");
});

test("the footer tells where to allow notifications", () => {
  render(<AttentionPage onOpenInbox={() => {}} />);
  expect(
    screen.getByText(
      "No notification? Allow ticketd in System Settings → Notifications.",
    ),
  ).toBeTruthy();
});

test("the Inbox row opens the Attention inbox", () => {
  const open = vi.fn();
  render(<AttentionPage onOpenInbox={open} />);
  expect(screen.getByText("Attention inbox")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Open the Attention inbox" }),
  );
  expect(open).toHaveBeenCalledTimes(1);
});

test("denied permission shows the blocked alert and leaves the switch off", async () => {
  vi.mocked(notificationClient.requestPermission).mockResolvedValue(false);
  render(<AttentionPage onOpenInbox={() => {}} />);
  fireEvent.click(notifySwitch());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Notifications are blocked for ticketd");
  expect(alert.textContent).toContain("notification settings");
  expect(notifySwitch().getAttribute("aria-checked")).toBe("false");
  expect(loadPreferences().notifyReminders).toBe(false);
});

test("permission withdrawn in system settings turns the switch off on opening", async () => {
  setPreference("notifyReminders", true);
  vi.mocked(notificationClient.permitted).mockResolvedValue(false);
  render(<AttentionPage onOpenInbox={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Notifications are blocked for ticketd",
  );
  expect(notifySwitch().getAttribute("aria-checked")).toBe("false");
});

test("a failed permission request is reported beside Reminders", async () => {
  vi.mocked(notificationClient.requestPermission).mockRejectedValue(
    new Error("boom"),
  );
  render(<AttentionPage onOpenInbox={() => {}} />);
  fireEvent.click(notifySwitch());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't ask for notification permission. Boom.",
  );
});

test("the notify switch is disabled while permission is being asked", () => {
  vi.mocked(notificationClient.requestPermission).mockReturnValue(
    new Promise(() => {}),
  );
  render(<AttentionPage onOpenInbox={() => {}} />);
  fireEvent.click(notifySwitch());
  expect((notifySwitch() as HTMLButtonElement).disabled).toBe(true);
});

test("a follow preference that cannot be saved says so", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  render(<AttentionPage onOpenInbox={() => {}} />);
  fireEvent.click(
    screen.getByRole("switch", { name: "Follow tickets I create" }),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Couldn't save the follow preference.",
  );
});
