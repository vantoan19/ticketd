// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { LinkedRecord } from "@/features/chats/client";
import { Composer } from "@/features/chats/Composer";
import {
  ComposerAttachments,
  captureClipboardImage,
} from "@/features/chats/composer-attachments";

afterEach(cleanup);

test("pastes a removable screenshot and sends the image without text", async () => {
  const image = new File(["clipboard bytes"], "image.png", {
    type: "image/png",
  });
  const attachment = {
    name: "image.png",
    dataUrl: "data:image/png;base64,Y2xpcGJvYXJkIGJ5dGVz",
  };
  const capture = vi.fn(async () => attachment);
  const onSend = vi.fn(async () => {});
  render(
    <Composer
      placeholder="Message"
      controls={(text, hasAttachments) => ({
        send: "send",
        enabled: text.trim() !== "" || hasAttachments,
      })}
      onSend={onSend}
      attachments={new ComposerAttachments(capture)}
    />,
  );
  const box = screen.getByRole("textbox", { name: "Message" });
  const paste = () =>
    fireEvent.paste(box, { clipboardData: { files: [image] } });
  expect(paste()).toBe(false);
  await screen.findByRole("img", { name: "image.png" });
  fireEvent.click(screen.getByRole("button", { name: "Remove image.png" }));
  expect(screen.queryByRole("img", { name: "image.png" })).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled,
  ).toBe(true);

  paste();
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(box, { key: "Enter" });
  expect(capture).toHaveBeenCalledWith(image);
  expect(onSend).toHaveBeenCalledWith("", [], [attachment]);
});

test("an oversized pasted image blocks sending until it is removed", async () => {
  const onSend = vi.fn(async () => {});
  const draft = new ComposerAttachments((file) =>
    captureClipboardImage(file, 10),
  );
  render(
    <Composer
      placeholder="Message"
      controls={(text, hasAttachments) => ({
        send: "send",
        enabled: text.trim() !== "" || hasAttachments,
      })}
      initialText="Keep this sentence"
      onSend={onSend}
      attachments={draft}
    />,
  );
  const box = screen.getByRole("textbox", { name: "Message" });
  const image = new File(["clipboard bytes"], "image.png", {
    type: "image/png",
  });
  fireEvent.paste(box, { clipboardData: { files: [image] } });
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /upload limit/i,
  );
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(box).toHaveProperty("value", "Keep this sentence");
  fireEvent.click(screen.getByRole("button", { name: "Remove image.png" }));
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).toHaveBeenCalledWith("Keep this sentence", []);
});

const ticket: LinkedRecord = {
  kind: "ticket",
  id: "t1",
  reference: "T-KQ12",
  title: "Login rate limits",
  status: "Todo",
};

function type(box: HTMLTextAreaElement, text: string) {
  fireEvent.change(box, {
    target: { value: text, selectionStart: text.length },
  });
}

function setup(
  commands: { name: string }[] = [],
  found: LinkedRecord[] = [ticket],
) {
  const onSend = vi.fn(async () => {});
  render(
    <Composer
      placeholder="Message"
      controls={(text) => ({ send: "send", enabled: text.trim() !== "" })}
      onSend={onSend}
      mentions={{
        records: async () => found,
        linked: [],
        folder: {
          name: "api",
          files: async () => [{ path: "src/limiter.ts", folder: false }],
        },
        commands,
        harness: "Claude Code",
      }}
    />,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  return { box, onSend };
}

test("a # mention inserts the record without sending, and the message links it when sent", async () => {
  const { box, onSend } = setup();
  type(box, "Look at #rate");
  const option = await screen.findByRole("option", { name: /T-KQ12/ });
  expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(screen.getByText("Links when you send")).toBeTruthy();
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(box.value).toBe("Look at T-KQ12 ");
  expect(option.isConnected).toBe(false);

  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).toHaveBeenCalledWith("Look at T-KQ12", [
    { kind: "ticket", id: "t1" },
  ]);
});

test("Enter never sends while the # menu is open, even with no row to pick (chat CH-46)", async () => {
  const { box, onSend } = setup();
  // Still searching: no row is highlighted yet.
  type(box, "Look at #zzz");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(box.value).toBe("Look at #zzz");
});

test("# with nothing typed offers the linked records, then the recently updated ones", async () => {
  const { box } = setup();
  type(box, "#");
  expect(await screen.findByText("Recent")).toBeTruthy();
  expect(await screen.findByRole("option", { name: /T-KQ12/ })).toBeTruthy();
});

test("Backspace removes a mention whole, and a deleted mention links nothing", async () => {
  const { box, onSend } = setup();
  type(box, "#rate");
  await screen.findByRole("option", { name: /T-KQ12/ });
  fireEvent.keyDown(box, { key: "Tab" });
  type(box, "T-KQ12 fix");
  box.setSelectionRange(6, 6);
  fireEvent.keyDown(box, { key: "Backspace" });
  expect(box.value).toBe(" fix");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).toHaveBeenCalledWith("fix", []);
});

test("@ lists files in the folder, Escape closes the menu and keeps the text, and / opens only when the harness lists commands", async () => {
  const { box } = setup();
  type(box, "see @lim");
  expect(await screen.findByText("Files in api")).toBeTruthy();
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box.value).toBe("see @lim");

  type(box, "/rev");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("/ at the start of a message offers the harness's commands", async () => {
  const { box } = setup([{ name: "review" }]);
  type(box, "/rev");
  expect(await screen.findByText("Claude Code commands")).toBeTruthy();
  fireEvent.keyDown(box, { key: "Enter" });
  expect(box.value).toBe("/review ");
});

test("CH-46: Enter while the # menu has no row to insert never sends", async () => {
  const { box, onSend } = setup([], []);
  type(box, "Look at #zzz");
  // Still searching: no row is highlighted yet.
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  // Nothing matches.
  await screen.findByText(/has that in its name/);
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(box.value).toBe("Look at #zzz");
});
