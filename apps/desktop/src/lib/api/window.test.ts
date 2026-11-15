// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { windowClient } from "./window";

afterEach(clearMocks);

test("startup tells the native watchdog to stop only after the window is shown", async () => {
  const commands: string[] = [];
  let finishShow: (() => void) | undefined;
  const showing = new Promise<void>((resolve) => {
    finishShow = resolve;
  });
  mockWindows("main");
  mockIPC((command, args) => {
    commands.push(command);
    if (command === "plugin:window|show") return showing;
    if (command === "plugin:event|emit_to") {
      expect(args).toMatchObject({
        target: { kind: "App" },
        event: "ticketd://startup-revealed",
      });
      return;
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const launch = windowClient.show();
  expect(commands).toEqual(["plugin:window|show"]);
  finishShow?.();
  await launch;
  expect(commands).toEqual(["plugin:window|show", "plugin:event|emit_to"]);
});

test("a failed initial reveal leaves the native watchdog armed", async () => {
  const commands: string[] = [];
  mockWindows("main");
  mockIPC((command) => {
    commands.push(command);
    throw new Error("Window unavailable");
  });
  await expect(windowClient.show()).rejects.toThrow("Window unavailable");
  expect(commands).toEqual(["plugin:window|show"]);
});
