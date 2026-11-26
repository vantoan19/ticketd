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
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ChatClientContext,
  type HarnessOptions,
} from "@/features/chats/client";
import {
  createMockChatClient,
  HARNESS_OPTIONS,
  type MockChatClient,
} from "@/features/chats/mock-client";
import { rememberPick } from "@/features/chats/harness-pick";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { cliClient } from "@/lib/api/cli";
import { sourcesClient } from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { openLink: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn().mockRejectedValue(new Error("no")) },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn().mockRejectedValue(new Error("no")) },
}));
vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: { permission: vi.fn(), notify: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(sourcesClient.list).mockResolvedValue([]);
  vi.mocked(cliClient.check).mockRejectedValue(new Error("no"));
  vi.mocked(agentSkillsClient.list).mockRejectedValue(new Error("no"));
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

/** The three agents the boards show: ready, one sign-in away, not installed. */
const BOARD = [
  {
    id: "claude-code",
    name: "Claude Code",
    status: "ready",
    version: "2.1.37",
    path: "/Users/sam/.local/bin/claude",
    sign_in_command: "claude /login",
  },
  {
    id: "codex",
    name: "Codex",
    status: "not_signed_in",
    version: "0.98.0",
    path: "/opt/homebrew/bin/codex",
    command: "codex login",
    sign_in_command: "codex login",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    status: "not_installed",
    help_url: "https://antigravity.google/docs/ide/extensions/acp/",
    sign_in_command: "agy",
  },
] as const;

function spied(enabled: boolean, harnesses: unknown[] = [...BOARD]) {
  const client = createMockChatClient({
    enabled,
    harnesses: harnesses as never,
  });
  client.harnesses = vi.fn(client.harnesses);
  client.installedHarnesses = vi.fn(client.installedHarnesses);
  client.harnessOptions = vi.fn(client.harnessOptions);
  return client;
}

/** Settings as the app mounts it: one state, the sidebar, and the page it selects. */
function Settings({
  client,
  initial = "agents",
  onOpenAutomations = () => {},
}: {
  client: MockChatClient;
  initial?: SettingsPageId;
  onOpenAutomations?: () => void;
}) {
  const [selected, setSelected] = useState<SettingsPageId>(initial);
  return (
    <ChatClientContext value={client}>
      <ChatProvider>
        <SettingsStateProvider onOpenPage={setSelected}>
          <SettingsNav
            selected={selected}
            onSelect={setSelected}
            onBack={() => {}}
          />
          <SettingsView
            selected={selected}
            onSelect={setSelected}
            onOpenAutomations={onOpenAutomations}
            onRestore={async () => {}}
          />
        </SettingsStateProvider>
      </ChatProvider>
    </ChatClientContext>
  );
}

const row = (name: string) =>
  within(screen.getByRole("list", { name: "Agents" }))
    .getByText(name)
    .closest('[role="listitem"]') as HTMLElement;
const navItem = (name: string) =>
  within(screen.getByRole("complementary", { name: "Settings" })).getByRole(
    "button",
    { name: new RegExp(`^${name}`) },
  );
const chatsSwitch = () => screen.getByRole("switch", { name: /^Chats/ });
const settled = () => act(async () => {});

test("Chats off: the agents are listed with their versions, and no sign-in is ever checked", async () => {
  const client = spied(false);
  render(<Settings client={client} />);
  await screen.findByRole("list", { name: "Agents" });
  await settled();

  expect(chatsSwitch().getAttribute("aria-checked")).toBe("false");
  expect(row("Claude Code").textContent).toContain("Version 2.1.37");
  expect(row("Codex").textContent).toContain("Version 0.98.0");
  expect(row("Antigravity").textContent).toContain("Not installed");
  // No words, no fixes, no chevrons, no Check again.
  for (const name of ["Claude Code", "Codex", "Antigravity"]) {
    expect(within(row(name)).queryByRole("button")).toBeNull();
    expect(row(name).textContent).not.toMatch(/Ready|Not signed in/);
  }
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  expect(screen.queryByText(/never sees your passwords or keys/)).toBeNull();

  // Neither the first read, nor the window regaining focus, nor the page
  // being opened and left again asks an agent about its sign-in.
  fireEvent(window, new Event("focus"));
  await settled();
  fireEvent.click(navItem("Appearance"));
  fireEvent.click(navItem("Agents"));
  await screen.findByRole("list", { name: "Agents" });
  await settled();
  expect(client.installedHarnesses).toHaveBeenCalled();
  expect(client.harnesses).not.toHaveBeenCalled();
  expect(client.harnessOptions).not.toHaveBeenCalled();
});

test("Chats off still says where to teach the agents ticketd, and is a page of three sections' worth", async () => {
  render(<Settings client={spied(false)} />);
  await screen.findByRole("list", { name: "Agents" });
  expect(
    screen.getByRole("heading", { level: 2, name: "On this computer" }),
  ).toBeTruthy();
  expect(screen.getByText("Experimental")).toBeTruthy();
  expect(
    screen.getByText("Not yet tested with every subscription plan."),
  ).toBeTruthy();
  fireEvent.click(
    within(
      screen.getByText(/To let them use ticketd in their own terminal/),
    ).getByRole("button", {
      name: "Agent skills",
    }),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Agent skills" }),
  ).toBeTruthy();
});

test("turning Chats on checks each agent's sign-in and shows the word, the fix and a way in", async () => {
  const client = spied(false);
  render(<Settings client={client} />);
  await screen.findByRole("list", { name: "Agents" });
  expect(client.harnesses).not.toHaveBeenCalled();

  fireEvent.click(chatsSwitch());
  await waitFor(() => expect(client.harnesses).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(row("Claude Code").textContent).toContain("Ready"),
  );

  expect(row("Claude Code").textContent).toContain(
    "Signed in · version 2.1.37",
  );
  expect(row("Codex").textContent).toContain("Not signed in");
  expect(row("Codex").textContent).toContain(
    "Run codex login in a terminal to sign in.",
  );
  expect(row("Antigravity").textContent).toContain("Not installed");
  expect(row("Antigravity").textContent).toContain(
    "Install Antigravity to use it here.",
  );
  // The one fix is labelled, and only where there is one.
  expect(
    within(row("Codex")).getByRole("button", { name: "Copy command for Codex" })
      .textContent,
  ).toBe("Copy command");
  expect(
    within(row("Claude Code")).queryByRole("button", { name: /Copy command/ }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Each agent keeps its own sign-in. ticketd never sees your passwords or keys.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Claude Code" })).toBeTruthy();
});

test("a missing sign-in has one fix: copying its command", async () => {
  render(<Settings client={spied(true)} />);
  await screen.findByRole("list", { name: "Agents" });
  await waitFor(() =>
    expect(row("Codex").textContent).toContain("Not signed in"),
  );
  fireEvent.click(
    within(row("Codex")).getByRole("button", {
      name: "Copy command for Codex",
    }),
  );
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("codex login"),
  );
  expect(
    await within(row("Codex")).findByRole("button", { name: /Copy command/ }),
  ).toHaveProperty("textContent", "Copied");
});

test("checks run again when the window regains focus, and Check again runs them too", async () => {
  const client = spied(true);
  render(<Settings client={client} />);
  await screen.findByRole("list", { name: "Agents" });
  await waitFor(() => expect(client.harnesses).toHaveBeenCalledTimes(1));
  await settled();

  // The person signs in to Codex in a terminal and comes back.
  client.setHarnesses([
    { ...BOARD[0] },
    { ...BOARD[1], status: "ready", command: null },
    { ...BOARD[2] },
  ] as never);
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(client.harnesses).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(row("Codex").textContent).toContain("Ready"));
  expect(
    within(row("Codex")).queryByRole("button", { name: /Copy command/ }),
  ).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(client.harnesses).toHaveBeenCalledTimes(3));
});

test("an agent that could not be checked says so and offers Check again on its row", async () => {
  const client = spied(true, [
    { id: "claude-code", name: "Claude Code", status: "unknown" },
  ]);
  render(<Settings client={client} />);
  await screen.findByRole("list", { name: "Agents" });
  await waitFor(() =>
    expect(row("Claude Code").textContent).toContain("Couldn't check"),
  );
  fireEvent.click(
    within(row("Claude Code")).getByRole("button", { name: "Check again" }),
  );
  await waitFor(() => expect(client.harnesses).toHaveBeenCalledTimes(2));
});

test("the nav's dot follows the same check: no usable agent needs setup", async () => {
  const client = spied(true, [
    { id: "claude-code", name: "Claude Code", status: "not_installed" },
    { id: "codex", name: "Codex", status: "not_installed" },
  ]);
  render(<Settings client={client} />);
  await screen.findByRole("list", { name: "Agents" });
  await waitFor(() =>
    expect(
      within(navItem("Agents")).getByRole("img", { name: "Needs setup" }),
    ).toBeTruthy(),
  );
  // One check answered the page and the dot.
  expect(client.harnesses).toHaveBeenCalledTimes(1);
});

test("a row opens its agent in place: breadcrumb, back control, sign-in, program, and the sidebar stays on Agents", async () => {
  rememberPick("claude-code", {
    model: "opus",
    effort: "high",
    permission: "default",
  });
  const client = spied(true);
  client.options.set("claude-code", opusOptions());
  render(<Settings client={client} />);
  await screen.findByRole("list", { name: "Agents" });
  await waitFor(() =>
    expect(row("Claude Code").textContent).toContain("Ready"),
  );
  const calls = vi.mocked(client.harnesses).mock.calls.length;

  fireEvent.click(row("Claude Code"));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Claude Code" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("AIAgentsClaude Code");
  expect(screen.getByRole("button", { name: "Back to Agents" })).toBeTruthy();
  expect(navItem("Agents").getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByText("Runs your Chats with its own sign-in and settings."),
  ).toBeTruthy();

  // Sign-in: the agent's own word, and how to switch accounts its own way.
  const signIn = screen
    .getByRole("heading", { level: 2, name: "Sign-in" })
    .closest("section") as HTMLElement;
  expect(signIn.textContent).toContain("Signed in");
  expect(signIn.textContent).toContain(
    "Claude Code keeps its own sign-in. To switch accounts, run claude /login in a terminal.",
  );
  // Program: version and path; no path setting.
  const program = screen
    .getByRole("heading", { level: 2, name: "Program" })
    .closest("section") as HTMLElement;
  expect(program.textContent).toContain("2.1.37");
  expect(program.textContent).toContain("claude");
  expect(within(program).queryByRole("textbox")).toBeNull();
  expect(within(program).queryByRole("button")).toBeNull();
  // What New Chat last used, as a fact: not a picker.
  const start = screen
    .getByRole("heading", { level: 2, name: "New Chat starts with" })
    .closest("section") as HTMLElement;
  await within(start).findByText("Opus 5.5 · High · Ask before edits");
  expect(start.textContent).toContain(
    "What you last chose for Claude Code. Change it in New Chat.",
  );
  expect(within(start).queryByRole("combobox")).toBeNull();
  // Opening it did not check anything again.
  expect(client.harnesses).toHaveBeenCalledTimes(calls);

  fireEvent.click(screen.getByRole("button", { name: "Back to Agents" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Agents" }),
  ).toBeTruthy();
});

test("Escape and the breadcrumb return from an opened agent", async () => {
  render(<Settings client={spied(true)} initial="agent-codex" />);
  await screen.findByRole("heading", { level: 1, name: "Codex" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(
    await screen.findByRole("heading", { level: 1, name: "Agents" }),
  ).toBeTruthy();

  fireEvent.click(row("Codex"));
  await screen.findByRole("heading", { level: 1, name: "Codex" });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole(
      "button",
      { name: "Agents" },
    ),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Agents" }),
  ).toBeTruthy();
});

test("an agent that is not signed in shows the same fix in its opened view", async () => {
  render(<Settings client={spied(true)} initial="agent-codex" />);
  await screen.findByRole("heading", { level: 1, name: "Codex" });
  const signIn = () =>
    screen
      .getByRole("heading", { level: 2, name: "Sign-in" })
      .closest("section") as HTMLElement;
  await waitFor(() => expect(signIn().textContent).toContain("Not signed in"));
  expect(signIn().textContent).toContain(
    "Run codex login in a terminal to sign in.",
  );
  fireEvent.click(
    within(signIn()).getByRole("button", { name: "Copy command for Codex" }),
  );
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("codex login"),
  );
  // Not signed in means New Chat can't start it yet: no remembered start to show.
  expect(screen.queryByText("New Chat starts with")).toBeNull();
});

test("an agent that is not installed offers where to get it, in its opened view", async () => {
  render(<Settings client={spied(true)} initial="agent-antigravity" />);
  await screen.findByRole("heading", { level: 1, name: "Antigravity" });
  expect(screen.queryByRole("heading", { name: "Sign-in" })).toBeNull();
  const get = await screen.findByRole("button", { name: /Get Antigravity/ });
  expect(screen.getByText("Install Antigravity to use it here.")).toBeTruthy();
  fireEvent.click(get);
  expect(workspaceClient.openLink).toHaveBeenCalledWith(
    "https://antigravity.google/docs/ide/extensions/acp/",
  );
});

test("Open New Chat leaves Settings for New Chat, starting with this agent", async () => {
  const client = spied(true);
  client.options.set("claude-code", opusOptions());
  render(<Settings client={client} initial="agent-claude-code" />);
  fireEvent.click(await screen.findByRole("button", { name: "Open New Chat" }));
  expect(localStorage.getItem("ticketd.chat-harness")).toBe("claude-code");
});

test("the Agents page has no notifications row; they live on Attention", async () => {
  render(<Settings client={spied(true)} />);
  await screen.findByRole("list", { name: "Agents" });
  expect(screen.queryByText(/Notify me about Chats/)).toBeNull();
  expect(screen.queryByText("Harnesses")).toBeNull();
});

/** What Claude Code lists: Opus 5.5 at High, asking before edits. */
function opusOptions(): HarnessOptions {
  const base = HARNESS_OPTIONS.find(
    (item) => item.harness_id === "claude-code",
  );
  if (!base) throw new Error("fixture");
  return {
    ...base,
    models: [
      {
        id: "opus",
        label: "Opus 5.5",
        is_default: true,
        allowed: true,
        efforts: [
          { id: "high", label: "High", is_default: true, allowed: true },
        ],
      },
    ],
    permission: {
      current: null,
      changeable: true,
      applies_from: "next_turn",
      options: [
        {
          id: "default",
          label: "Ask before edits",
          is_default: true,
          allowed: true,
        },
      ],
    },
  };
}
