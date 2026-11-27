import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CommandLineCard } from "@/features/settings/CommandLineCard";
import { commandLineFix } from "@/features/settings/command-line-state";
import type { CliStatus } from "@/lib/api/cli";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const bundled = (
  platform: "macos" | "windows" | "linux",
  overrides: Record<string, unknown> = {},
) => ({
  platform,
  installed: false,
  needs_repair: false,
  in_the_way: null,
  ...overrides,
});

/** The copy of this app is first on PATH and everything matches. */
const matching = {
  found: true,
  on_path: true,
  path: "/usr/local/bin/ticketd",
  version: "0.2.0",
  version_matches: true,
  workspace_path: "/data/workspace.sqlite3",
  workspace_matches: true,
  app_version: "0.2.0",
  app_workspace_path: "/data/workspace.sqlite3",
  suggested_directory: "/usr/local/bin",
  bundled: bundled("macos", { installed: true }),
};

const missing = {
  ...matching,
  found: false,
  on_path: false,
  path: null,
  version: null,
  version_matches: null,
  workspace_path: null,
  workspace_matches: null,
  bundled: bundled("macos"),
};

const older = {
  path: "/usr/local/bin/ticketd",
  version: "0.1.0",
};

const olderFirst = {
  ...matching,
  version: "0.1.0",
  version_matches: false,
  bundled: bundled("macos", { in_the_way: older }),
};

const installed = {
  outcome: "installed",
  directory: "/usr/local/bin",
  next_step: null,
};

/** Answers the bridge by command name; `check_cli` answers in order, the last repeats. */
function bridge(checks: unknown[], others: Record<string, unknown> = {}) {
  let next = 0;
  invoke.mockImplementation((command: string) => {
    if (command === "check_cli")
      return Promise.resolve(checks[Math.min(next++, checks.length - 1)]);
    if (command in others) {
      const answer = others[command];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  });
}

const commands = () => invoke.mock.calls.map(([command]) => command);

test("Installed: one sentence, Check again, and the copy's facts", async () => {
  bridge([matching]);
  render(<CommandLineCard />);

  expect(await screen.findByText("Installed")).toBeTruthy();
  expect(
    screen.getByText("Matches this app and uses this Workspace."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  const facts = document.querySelector(".cli-details");
  expect(facts?.textContent).toContain("0.2.0");
  expect(facts?.textContent).toContain("This Workspace");
  expect(
    document.querySelector('[data-slot="path-text"]')?.textContent,
  ).toContain("/usr/local/bin/ticketd");
  // Nothing to fix: no footer, no second action.
  expect(
    document.querySelector(".settings-list-footer-text")?.textContent,
  ).toBe("Agents learn these commands from the ticketd skill.");
  expect(
    screen.queryByRole("button", { name: "Installation guide" }),
  ).toBeNull();
});

test("Not installed: the one fix says what it does and that the password is asked once", async () => {
  bridge([missing, matching], { install_cli: installed });
  render(<CommandLineCard />);

  expect(await screen.findByText("Not installed")).toBeTruthy();
  expect(
    screen.getByText("Agents and terminals can’t run ticketd yet."),
  ).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Adds ticketd to /usr/local/bin. macOS asks for your administrator password once.",
  );
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Install command-line tool" }),
  );

  expect(await screen.findByText("Installed")).toBeTruthy();
  expect(commands()).toEqual(["check_cli", "install_cli", "check_cli"]);
  expect(invoke).toHaveBeenNthCalledWith(2, "install_cli", { other: null });
});

test("An older copy first: one action replaces it with one install call", async () => {
  bridge([olderFirst, matching], { install_cli: installed });
  render(<CommandLineCard />);

  expect(await screen.findByText("Doesn’t match this app")).toBeTruthy();
  expect(
    screen.getByText(
      "Agents and terminals run an older ticketd than this app.",
    ),
  ).toBeTruthy();
  expect(document.querySelector(".cli-details")?.textContent).toContain(
    "This app has 0.2.0",
  );
  expect(document.body.textContent).toContain(
    "Replaces ticketd 0.1.0 with this app’s copy. macOS asks for your administrator password once.",
  );
  // The cut escapes are gone.
  expect(screen.queryByRole("button", { name: "Keep it" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Use this app’s ticketd" }),
  );

  expect(await screen.findByText("Installed")).toBeTruthy();
  // Nothing is left to do, so the fix's footer goes with the fix.
  expect(document.body.textContent).not.toContain("administrator password");
  expect(document.body.textContent).not.toContain("Replaces ticketd");
  // Removing and installing is one call, so the system asks once.
  expect(invoke.mock.calls.filter(([c]) => c === "install_cli")).toEqual([
    ["install_cli", { other: older }],
  ]);
  expect(commands()).not.toContain("remove_older_cli");
});

test("A newer copy and a copy that reads another Workspace get the same fix", async () => {
  bridge([{ ...olderFirst, version: "0.3.0" }]);
  const view = render(<CommandLineCard />);
  expect(
    await screen.findByText(
      "Agents and terminals run a newer ticketd than this app.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Use this app’s ticketd" }),
  ).toBeTruthy();
  view.unmount();

  bridge([
    {
      ...matching,
      workspace_matches: false,
      bundled: bundled("macos", { in_the_way: { ...older, version: "0.2.0" } }),
    },
  ]);
  render(<CommandLineCard />);
  expect(await screen.findByText("Uses another Workspace")).toBeTruthy();
  expect(
    screen.getByText(
      "Agents would read and write tickets this app doesn’t show.",
    ),
  ).toBeTruthy();
  expect(document.querySelector(".cli-details")?.textContent).toContain(
    "Another Workspace",
  );
  expect(
    screen.getByRole("button", { name: "Use this app’s ticketd" }),
  ).toBeTruthy();
});

test("Declining the password changes nothing, says so, and offers the folder that needs none", async () => {
  bridge([olderFirst, { ...olderFirst }], {
    install_cli: {
      outcome: "declined",
      directory: "~/.local/bin",
      next_step: null,
    },
    install_cli_in_user_bin: {
      outcome: "installed",
      directory: "~/.local/bin",
      next_step: "add_to_path",
    },
  });
  render(<CommandLineCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Use this app’s ticketd" }),
  );

  expect(await screen.findByText("Nothing changed.")).toBeTruthy();
  // No recheck ran and nothing else was called: nothing changed.
  expect(commands()).toEqual(["check_cli", "install_cli"]);
  // The fix can be tried again.
  expect(
    screen.getByRole("button", { name: "Use this app’s ticketd" }),
  ).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: "Use ~/.local/bin instead" }),
  );

  expect(
    await screen.findByText(
      "Add ~/.local/bin to your PATH, then open a new terminal.",
    ),
  ).toBeTruthy();
  expect(commands()).toEqual([
    "check_cli",
    "install_cli",
    "install_cli_in_user_bin",
    "check_cli",
  ]);
});

test("Windows adds the app's folder without a password and asks for a restart", async () => {
  bridge([{ ...missing, bundled: bundled("windows") }, matching], {
    install_cli: {
      outcome: "installed",
      directory: "C:\\Program Files\\ticketd",
      next_step: "restart_terminals",
    },
  });
  render(<CommandLineCard />);

  await screen.findByText("Not installed");
  expect(document.body.textContent).toContain(
    "Adds this app’s folder to your PATH. Restart terminals and agents to pick it up.",
  );
  expect(document.body.textContent).not.toContain("administrator password");

  fireEvent.click(
    screen.getByRole("button", { name: "Install command-line tool" }),
  );
  await screen.findByText("Installed");
  expect(document.body.textContent).toContain(
    "Restart terminals and agents to pick it up.",
  );
});

test("On Linux the package installs it; only a copy in the way is replaced", async () => {
  bridge([{ ...missing, bundled: bundled("linux") }]);
  const view = render(<CommandLineCard />);
  await screen.findByText("Not installed");
  expect(
    screen.queryByRole("button", { name: "Install command-line tool" }),
  ).toBeNull();
  expect(screen.getByRole("list").textContent).toContain(
    "cargo build -p ticketd-cli",
  );
  expect(
    screen.getByRole("button", { name: "Installation guide" }),
  ).toBeTruthy();
  view.unmount();

  bridge([
    {
      ...olderFirst,
      bundled: bundled("linux", { in_the_way: older }),
    },
  ]);
  render(<CommandLineCard />);
  expect(
    await screen.findByRole("button", { name: "Use this app’s ticketd" }),
  ).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Removes ticketd 0.1.0 so this app’s copy comes first.",
  );
  expect(document.body.textContent).not.toContain("administrator");
});

test("The fix is the same call for every cause, so Set up ticketd can run it", () => {
  const status = (overrides: Partial<CliStatus>): CliStatus => ({
    ...(matching as unknown as CliStatus),
    ...overrides,
  });
  expect(commandLineFix(status({}))).toBeNull();
  expect(commandLineFix(missing as unknown as CliStatus)).toEqual({
    other: null,
  });
  expect(commandLineFix(olderFirst as unknown as CliStatus)).toEqual({
    other: older,
  });
  // A build without a bundled copy has nothing to install.
  expect(
    commandLineFix(status({ bundled: undefined, found: false })),
  ).toBeNull();
});

test("Without a bundled copy a copy that is not on PATH links the guide", async () => {
  const source = { ...matching, on_path: false, bundled: undefined };
  bridge([source]);
  render(<CommandLineCard />);

  expect(await screen.findByText("Found, but not on your PATH")).toBeTruthy();
  expect(screen.queryByText("Installed")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Installation guide" }),
  ).toBeTruthy();
});

test("an installation guide that cannot open says so", async () => {
  const source = { ...matching, on_path: false, bundled: undefined };
  bridge([source]);
  vi.mocked(openUrl).mockRejectedValueOnce(new Error("No browser"));
  render(<CommandLineCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Installation guide" }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't open the installation guide.");
  await revealFailureDetails();
  expect(alert.textContent).toContain("No browser");
  vi.mocked(openUrl).mockResolvedValueOnce(undefined);
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a failed install says why and offers Retry", async () => {
  bridge([missing], {
    install_cli: new Error("/usr/local/bin/ticketd already exists."),
  });
  render(<CommandLineCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Install command-line tool" }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "Couldn't install the command-line tool.",
  );
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("a failed check keeps the page and offers Check again", async () => {
  invoke.mockRejectedValueOnce(new Error("shell failed"));
  render(<CommandLineCard />);
  expect(await screen.findByText("Couldn't check")).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();

  invoke.mockResolvedValueOnce(matching);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Installed")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the status is read again when the window comes back", async () => {
  bridge([missing, matching]);
  render(<CommandLineCard />);
  await screen.findByText("Not installed");

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });

  expect(await screen.findByText("Installed")).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith("check_cli", { refreshPath: true });
});

test("Check again is disabled while checking", async () => {
  bridge([matching]);
  render(<CommandLineCard />);
  await screen.findByText("Installed");
  bridge([matching]);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(
    screen
      .getByRole("button", { name: "Checking…" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await screen.findByRole("button", { name: "Check again" });
});

test("copies a quick-reference command", async () => {
  bridge([matching]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<CommandLineCard />);
  fireEvent.click(
    screen.getByRole("button", { name: /Copy: List Ready tickets/ }),
  );
  expect(writeText).toHaveBeenCalledWith(
    "ticketd list --project PROJECT_ID --availability ready",
  );
  expect(await screen.findByText("Copied")).toBeTruthy();
});

test("the footer sends people to Agent skills", async () => {
  bridge([matching]);
  const openPage = vi.fn();
  const state: SettingsState = {
    query: "",
    setQuery: () => {},
    openPage,
    needsSetup: {},
    refreshIndicators: () => {},
  };
  render(
    <SettingsStateContext.Provider value={state}>
      <CommandLineCard />
    </SettingsStateContext.Provider>,
  );
  const link = screen.getByRole("button", { name: "Agent skills" });
  expect(link.dataset.slot).toBe("settings-link");
  fireEvent.click(link);
  expect(openPage).toHaveBeenCalledWith("agent-skills");
});
