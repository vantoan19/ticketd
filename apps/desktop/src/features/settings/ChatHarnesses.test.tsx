// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import {
  ChatFeatureContext,
  NO_CHAT_OVERVIEW,
} from "@/features/chats/use-chats";
import { ChatHarnesses } from "@/features/settings/ChatHarnesses";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import { useSettingsState } from "@/features/settings/use-settings-state";

vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn().mockRejectedValue(new Error("no")) },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn().mockRejectedValue(new Error("no")) },
}));

afterEach(() => {
  cleanup();
});

const feature = {
  enabled: true,
  setEnabled: async () => {},
  overview: NO_CHAT_OVERVIEW,
  revision: 0,
  openRequest: null,
  chatRequest: null,
  requestChat: () => {},
};

function ChatDot() {
  const { needsSetup } = useSettingsState();
  return <p>{needsSetup.chat ? "Chat needs setup" : "Chat is set up"}</p>;
}

function renderWith(client: ReturnType<typeof createMockChatClient>) {
  render(
    <ChatClientContext value={client}>
      <ChatFeatureContext value={feature}>
        <SettingsStateProvider>
          <ChatDot />
          <ChatHarnesses />
        </SettingsStateProvider>
      </ChatFeatureContext>
    </ChatClientContext>,
  );
}

test("each harness is a row with its status in words", async () => {
  renderWith(
    createMockChatClient({
      harnesses: [
        {
          id: "claude-code",
          name: "Claude Code",
          status: "ready",
          version: "2.1.3",
        },
        {
          id: "codex",
          name: "Codex",
          status: "not_signed_in",
          command: "codex login",
        },
        { id: "fixture-harness", name: "Fixture Harness", status: "ready" },
      ],
    }),
  );
  const list = await screen.findByRole("list", { name: "Harnesses" });
  const [claude, codex] = within(list).getAllByRole("listitem");
  expect(within(list).getByText("Fixture Harness")).toBeTruthy();
  expect(claude?.textContent).toContain("Ready");
  expect(claude?.textContent).toContain("Version 2.1.3.");
  expect(codex?.textContent).toContain("Not signed in");
  expect(
    within(codex as HTMLElement).getByRole("button", {
      name: "Copy command Codex",
    }),
  ).toBeTruthy();
  await act(async () => {});
  expect(screen.getByText("Chat is set up")).toBeTruthy();
});

test("with no usable harness the nav's Chat item needs setup", async () => {
  renderWith(
    createMockChatClient({
      harnesses: [
        { id: "claude-code", name: "Claude Code", status: "not_installed" },
        { id: "codex", name: "Codex", status: "not_installed" },
      ],
    }),
  );
  expect(await screen.findByText("Chat needs setup")).toBeTruthy();
});
