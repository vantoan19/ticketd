import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { automationsClient } from "./client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => vi.resetAllMocks());

const automation = {
  id: "a1",
  name: "Triage",
  trigger: null,
  conditions: [],
  steps: [],
  enabled: false,
  arrived_off: false,
  problems: [],
  has_ticket: true,
};

// The desktop runs commands side by side, so an edit is sent only once the one
// before it has answered: typed "ab" then "abc" must not be stored as "ab".
test("edits reach the desktop one at a time, in the order they were made", async () => {
  const answers: (() => void)[] = [];
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => answers.push(() => resolve({ ...automation }))),
  );
  const definition = (name: string) => ({
    name,
    trigger: null,
    conditions: [],
    steps: [],
  });
  const first = automationsClient.updateAutomation(
    "a1",
    definition("ab"),
    true,
  );
  const second = automationsClient.updateAutomation(
    "a1",
    definition("abc"),
    true,
  );
  const enabled = automationsClient.setAutomationEnabled("a1", true);
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  answers.shift()?.();
  await first;
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(vi.mocked(invoke).mock.calls[1]?.[1]).toMatchObject({
    definition: { name: "abc" },
  });
  answers.shift()?.();
  await second;
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(vi.mocked(invoke).mock.calls[2]?.[0]).toBe("automation_set_enabled");
  answers.shift()?.();
  await enabled;
});
