// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext, type LinkedRecord } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { LinkedChats } from "@/features/chats/LinkedChats";
import { createMockChatClient } from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

const ticket: LinkedRecord = {
  kind: "ticket",
  id: "t1",
  reference: "T-KQ12",
  title: "Login rate limits",
  status: "Todo",
};

test.each([false, true])(
  "Chat about this ticket offers its prompt without changing a file-only draft (file attached: %s)",
  async (fileOnly) => {
    const client = createMockChatClient({ enabled: true, records: [ticket] });
    const create = vi.spyOn(client, "createChat");
    render(
      <ChatClientContext value={client}>
        <ChatProvider>
          <LinkedChats
            ticket={{ ...ticket, trashed: false }}
            folder="/work/api"
          />
          <ChatsView />
        </ChatProvider>
      </ChatClientContext>,
    );
    if (fileOnly) {
      fireEvent.change(await screen.findByLabelText("Choose files to attach"), {
        target: {
          files: [new File(["notes"], "unsent.txt", { type: "text/plain" })],
        },
      });
      await screen.findByRole("button", { name: "Remove unsent.txt" });
    }
    fireEvent.click(
      await screen.findByRole("button", { name: "Chat about this ticket" }),
    );
    const textbox = () =>
      screen.findByRole<HTMLTextAreaElement>("textbox", {
        name: "Describe a task or ask a question",
      });
    if (fileOnly) {
      expect((await textbox()).value).toBe("");
      expect(
        screen.getByRole("button", { name: "Remove unsent.txt" }),
      ).toBeTruthy();
      expect(screen.getByText(/Draft kept/)).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Use T-KQ12 prompt" }),
      );
    }
    const box = await textbox();
    expect(box.value).toBe("Work on T-KQ12: Login rate limits");
    expect(screen.getByRole("button", { name: "Back to T-KQ12" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Folder: /work/api" }),
    ).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: /Send/ })
          .disabled,
      ).toBe(false),
    );
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      folder: "/work/api",
      links: [{ kind: "ticket", id: "t1" }],
      message: "Work on T-KQ12: Login rate limits",
      ...(fileOnly && {
        attachments: [
          { name: "unsent.txt", dataUrl: "data:text/plain;base64,bm90ZXM=" },
        ],
      }),
    });
  },
);

test("a Codex Chat can find skills after its Project folder is missing", async () => {
  const client = createMockChatClient({
    enabled: true,
    harnesses: [{ id: "codex", name: "Codex", status: "ready" }],
  });
  vi.spyOn(client, "folderFiles").mockRejectedValueOnce(
    new Error("Folder is missing"),
  );
  const skills = vi
    .spyOn(client, "harnessSkills")
    .mockResolvedValue([{ name: "check-logs", description: "Inspect logs" }]);
  client.nextFolder = "/work/replacement";
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <LinkedChats
          ticket={{ ...ticket, trashed: false }}
          folder="/work/missing"
        />
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "Chat about this ticket" }),
  );
  const scratch = await screen.findByRole("button", { name: "Scratch folder" });
  await screen.findByText(/Project folder isn’t on this computer/);
  await screen.findByRole("button", { name: /Codex.*model/i });
  const box = screen.getByLabelText("Describe a task or ask a question");
  fireEvent.change(box, { target: { value: "$ch" } });
  await waitFor(() => expect(skills).toHaveBeenCalledWith("codex", null));
  expect(await screen.findByText("$check-logs")).toBeTruthy();

  fireEvent.keyDown(scratch, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Choose a folder…" }),
  );
  await screen.findByRole("button", { name: "Folder: /work/replacement" });
  fireEvent.change(box, { target: { value: "$che" } });
  await waitFor(() =>
    expect(skills).toHaveBeenCalledWith("codex", "/work/replacement"),
  );
  expect(await screen.findByText("$check-logs")).toBeTruthy();
  expect(
    screen.queryByText(/Project folder isn’t on this computer/),
  ).toBeNull();
  fireEvent.change(box, { target: { value: "" } });
});
