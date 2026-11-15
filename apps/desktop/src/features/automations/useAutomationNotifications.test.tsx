// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { onAction } from "@tauri-apps/plugin-notification";
import { useAutomationNotifications } from "@/features/automations/useAutomationNotifications";

vi.mock("@tauri-apps/plugin-notification", () => ({ onAction: vi.fn() }));
afterEach(cleanup);

test("a click on a Notify me notification opens its ticket or its run, and other notifications open nothing", async () => {
  const unregister = vi.fn(async () => {});
  vi.mocked(onAction).mockResolvedValue({ unregister } as never);
  const openTicket = vi.fn();
  const openRun = vi.fn();
  function Page() {
    useAutomationNotifications(true, openTicket, openRun);
    return null;
  }
  const page = render(<Page />);
  await waitFor(() => expect(onAction).toHaveBeenCalled());
  const click = (actionId: string, extra: Record<string, unknown>) =>
    vi.mocked(onAction).mock.calls[0]![0]({
      actionId,
      notification: { extra },
    } as never);
  const target = (opens: string, ticket_reference: string | null) => ({
    automation: {
      title: "Verify on staging",
      body: "Verified",
      opens,
      ticket_reference,
      automation_id: "automation-1",
      run_id: "run-1",
    },
  });

  click("tap", target("ticket", "T-KQ1"));
  expect(openTicket).toHaveBeenCalledExactlyOnceWith("T-KQ1");
  expect(openRun).not.toHaveBeenCalled();

  click("tap", target("run", "T-KQ1"));
  expect(openRun).toHaveBeenCalledExactlyOnceWith("run-1");

  // A reminder's notification, and a dismissal, are not this hook's.
  click("tap", { reference: "T-KQ2" });
  click("dismiss", target("ticket", "T-KQ3"));
  expect(openTicket).toHaveBeenCalledTimes(1);
  expect(openRun).toHaveBeenCalledTimes(1);

  page.unmount();
  expect(unregister).toHaveBeenCalled();
});
