// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ChatFeatureContext,
  type ChatFeature,
} from "@/features/chats/use-chats";
import {
  notificationClient,
  type NotificationPermission,
} from "@/lib/api/notifications";
import { resetNotificationPermission } from "@/lib/notification-permission";
import { loadPreferences, setPreference } from "@/lib/preferences";
import { AttentionPage } from "@/features/settings/pages/AttentionPage";

vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permission: vi.fn(),
    ask: vi.fn(),
    openSettings: vi.fn(),
    notify: vi.fn(),
  },
}));

const ALLOWED: NotificationPermission = {
  state: "allowed",
  reported: true,
  settings: true,
};
const NOT_ASKED: NotificationPermission = { ...ALLOWED, state: "not_asked" };
const BLOCKED: NotificationPermission = { ...ALLOWED, state: "blocked" };

const CHATS_ON = { enabled: true } as ChatFeature;
const CHATS_OFF = { enabled: false } as ChatFeature;

function page(chats: ChatFeature = CHATS_ON) {
  return render(
    <ChatFeatureContext value={chats}>
      <AttentionPage />
    </ChatFeatureContext>,
  );
}

beforeEach(() => {
  vi.mocked(notificationClient.permission).mockResolvedValue(ALLOWED);
  vi.mocked(notificationClient.openSettings).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  resetNotificationPermission();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const chatSwitch = () =>
  screen.getByRole("switch", { name: "Chat notifications" });
const button = (name: string) => screen.queryByRole("button", { name });

test("the page holds Following and Notifications, with no reminder switch and no Inbox row", async () => {
  page();
  await screen.findByText("Allowed");
  expect(
    screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent),
  ).toEqual(["Following", "Notifications"]);
  expect(screen.queryByRole("switch", { name: /reminder/i })).toBeNull();
  expect(screen.queryByText(/Attention inbox/)).toBeNull();
  expect(screen.queryByText(/No notification\?/)).toBeNull();
});

test("allowed: the row says Allowed, offers nothing to press, and Chat notifications are on", async () => {
  page();
  await screen.findByText("Allowed");
  expect(button("Allow notifications")).toBeNull();
  expect(button("Open System Settings")).toBeNull();
  expect(chatSwitch().getAttribute("aria-checked")).toBe("true");
  expect((chatSwitch() as HTMLButtonElement).disabled).toBe(false);
  expect(
    screen.getByText(
      "Due reminders, and Chats that need you, while ticketd is open.",
    ),
  ).toBeTruthy();
});

test("not asked yet: one Allow notifications button asks the system once, and the row then reads Allowed", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(NOT_ASKED);
  vi.mocked(notificationClient.ask).mockImplementation(async () => {
    vi.mocked(notificationClient.permission).mockResolvedValue(ALLOWED);
    return ALLOWED;
  });
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Allow notifications" }),
  );
  await screen.findByText("Allowed");
  expect(notificationClient.ask).toHaveBeenCalledTimes(1);
  expect(button("Allow notifications")).toBeNull();
});

test("the answer to the ask is what the row shows, even when the read after it fails", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(NOT_ASKED);
  vi.mocked(notificationClient.ask).mockImplementation(async () => {
    vi.mocked(notificationClient.permission).mockRejectedValue(
      new Error("unreadable"),
    );
    return ALLOWED;
  });
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Allow notifications" }),
  );
  await screen.findByText("Allowed");
  expect(button("Allow notifications")).toBeNull();
  expect((chatSwitch() as HTMLButtonElement).disabled).toBe(false);
});

test("where the system cannot say, the row does not claim Allowed", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue({
    ...ALLOWED,
    reported: false,
    settings: false,
  });
  page();
  await screen.findByText("Not reported");
  expect(screen.queryByText("Allowed")).toBeNull();
  expect(
    screen.getByText(/doesn’t say whether notifications are on/),
  ).toBeTruthy();
  // The delivery fallback stays: Chat notifications still work.
  expect((chatSwitch() as HTMLButtonElement).disabled).toBe(false);
});

test("until notifications are allowed Chat notifications read off and cannot change, and the choice comes back once allowed", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(NOT_ASKED);
  page();
  await screen.findByRole("button", { name: "Allow notifications" });
  expect(chatSwitch().getAttribute("aria-checked")).toBe("false");
  expect((chatSwitch() as HTMLButtonElement).disabled).toBe(true);
  // The saved choice was never touched.
  expect(loadPreferences().notifyChats).toBe(true);

  vi.mocked(notificationClient.permission).mockResolvedValue(ALLOWED);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(chatSwitch().getAttribute("aria-checked")).toBe("true"),
  );
});

test("a muted choice stays muted after notifications are allowed", async () => {
  setPreference("notifyChats", false);
  page();
  await screen.findByText("Allowed");
  expect(chatSwitch().getAttribute("aria-checked")).toBe("false");
  fireEvent.click(chatSwitch());
  expect(loadPreferences().notifyChats).toBe(true);
  expect(chatSwitch().getAttribute("aria-checked")).toBe("true");
});

test("blocked: the row says Blocked and where to allow it, and Open System Settings opens the system's settings", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(BLOCKED);
  page();
  await screen.findByText("Blocked");
  expect(
    screen.getByText("Off for ticketd in System Settings › Notifications."),
  ).toBeTruthy();
  expect(button("Allow notifications")).toBeNull();
  expect((chatSwitch() as HTMLButtonElement).disabled).toBe(true);
  expect(chatSwitch().getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
  expect(notificationClient.openSettings).toHaveBeenCalledTimes(1);
  expect(notificationClient.ask).not.toHaveBeenCalled();
});

test("blocked on a system with no settings to open offers no button", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue({
    ...BLOCKED,
    settings: false,
  });
  page();
  await screen.findByText("Blocked");
  expect(button("Open System Settings")).toBeNull();
});

test("blocked, then allowed in System Settings: the row is read again when the window regains focus", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(BLOCKED);
  page();
  await screen.findByText("Blocked");
  vi.mocked(notificationClient.permission).mockResolvedValue(ALLOWED);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await screen.findByText("Allowed");
  expect(screen.queryByText("Blocked")).toBeNull();
  expect(chatSwitch().getAttribute("aria-checked")).toBe("true");
});

test("without Chats the page has no Chat notifications row and the description drops Chats", async () => {
  page(CHATS_OFF);
  await screen.findByText("Allowed");
  expect(screen.queryByText("Chat notifications")).toBeNull();
  expect(screen.getByText("Due reminders while ticketd is open.")).toBeTruthy();
});

test("a failed ask is reported in the row", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(NOT_ASKED);
  vi.mocked(notificationClient.ask).mockRejectedValue(new Error("boom"));
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Allow notifications" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't ask for notification permission",
  );
});

test("a follow preference that cannot be saved says so", async () => {
  page();
  await screen.findByText("Allowed");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  fireEvent.click(
    screen.getByRole("switch", { name: "Follow tickets I create" }),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Couldn't save the follow preference.",
  );
});
