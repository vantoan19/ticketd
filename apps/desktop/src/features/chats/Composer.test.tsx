// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { LinkedRecord } from "@/features/chats/client";
import { Composer } from "@/features/chats/Composer";
import {
  ComposerAttachments,
  captureChatAttachment,
} from "@/features/chats/composer-attachments";

afterEach(cleanup);

test("picks several files and retries just the failed capture", async () => {
  const original = new File(["one"], "first.txt", { type: "text/plain" });
  const missing = new File(["two"], "second.txt", { type: "text/plain" });
  let unavailable = true;
  const capture = vi.fn(async (file: File) => {
    if (file === missing && unavailable) throw new Error("Cannot read file");
    return {
      name: file.name,
      dataUrl:
        file === original
          ? "data:text/plain;base64,b25l"
          : "data:text/plain;base64,dHdv",
    };
  });
  const onSend = vi.fn(async () => {});
  render(
    <Composer
      placeholder="Message"
      initialText="Use both files"
      controls={(text, hasAttachments) => ({
        send: "send",
        enabled: text.trim() !== "" || hasAttachments,
      })}
      onSend={onSend}
      attachments={new ComposerAttachments(capture)}
    />,
  );
  const picker = screen.getByLabelText("Choose files to attach");
  expect(picker).toHaveProperty("multiple", true);
  fireEvent.change(picker, { target: { files: [original, missing] } });
  await screen.findByRole("alert");
  fireEvent.change(picker, { target: { files: [] } });
  expect(screen.getByRole("button", { name: "Remove first.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  );
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry second.txt" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(capture.mock.calls).toEqual([[original], [missing], [missing]]);
  expect(onSend).toHaveBeenCalledWith(
    "Use both files",
    [],
    [
      { name: "first.txt", dataUrl: "data:text/plain;base64,b25l" },
      { name: "second.txt", dataUrl: "data:text/plain;base64,dHdv" },
    ],
  );
});

function setupAttachmentComposer(initialText = "") {
  const onSend = vi.fn(async () => {});
  render(
    <Composer
      placeholder="Message"
      initialText={initialText}
      controls={(text, hasAttachments) => ({
        send: "send",
        enabled: text.trim() !== "" || hasAttachments,
      })}
      onSend={onSend}
      attachments={
        new ComposerAttachments((file) => captureChatAttachment(file, 1024))
      }
    />,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  return { box, onSend };
}

test("pastes multiple files, removes one, and sends the other without text", async () => {
  const { box, onSend } = setupAttachmentComposer();
  const first = new File(["one"], "first.txt", { type: "text/plain" });
  const second = new File(["two"], "second.txt", { type: "text/plain" });
  expect(
    fireEvent.paste(box, { clipboardData: { files: [first, second] } }),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Remove first.txt" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Remove second.txt" }),
  ).toBeTruthy();
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  expect(onSend).toHaveBeenCalledWith(
    "",
    [],
    [{ name: "second.txt", dataUrl: "data:text/plain;base64,dHdv" }],
  );
});

test("pastes files supplied through clipboard items in order", async () => {
  const { box, onSend } = setupAttachmentComposer("Use these files");
  const first = new File(["one"], "first.txt", { type: "text/plain" });
  const second = new File(["two"], "second.txt", { type: "text/plain" });
  expect(
    fireEvent.paste(box, {
      clipboardData: {
        files: [],
        items: [
          { kind: "file", type: "text/plain", getAsFile: () => first },
          { kind: "string", type: "text/plain" },
          { kind: "file", type: "", getAsFile: () => null },
          { kind: "file", type: "text/plain", getAsFile: () => second },
        ],
      },
    }),
  ).toBe(false);
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  expect(onSend).toHaveBeenCalledWith(
    "Use these files",
    [],
    [
      { name: "first.txt", dataUrl: "data:text/plain;base64,b25l" },
      { name: "second.txt", dataUrl: "data:text/plain;base64,dHdv" },
    ],
  );
});

test("pastes a plain-text file path at the caret", async () => {
  const user = userEvent.setup();
  const { box, onSend } = setupAttachmentComposer("Open  next.");
  box.focus();
  box.setSelectionRange(5, 5);
  await user.paste("C:\\samples\\report.txt");
  expect(box.value).toBe("Open C:\\samples\\report.txt next.");
  expect(
    screen.queryByRole("list", { name: "Message attachments" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith("Open C:\\samples\\report.txt next.", []);
});

test("pastes a removable screenshot and sends the image without text", async () => {
  const { box, onSend } = setupAttachmentComposer();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhQAAAABJRU5ErkJggg==";
  const image = new File(
    [Uint8Array.from(atob(png), (byte) => byte.charCodeAt(0))],
    "image.png",
    {
      type: "image/png",
    },
  );
  const attachment = {
    name: "image.png",
    dataUrl: `data:image/png;base64,${png}`,
  };
  const paste = () =>
    fireEvent.paste(box, {
      clipboardData: {
        files: [image],
        items: [
          { kind: "file", type: "image/png", getAsFile: () => image },
          {
            kind: "file",
            type: "image/jpeg",
            getAsFile: () =>
              new File(["alternate bytes"], "image.jpg", {
                type: "image/jpeg",
              }),
          },
          { kind: "string", type: "text/html" },
        ],
      },
    });
  expect(paste()).toBe(false);
  await screen.findByRole("img", { name: "image.png" });
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
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
  expect(onSend).toHaveBeenCalledWith("", [], [attachment]);
});

test("a mismatched PNG fails capture and can be removed while its caption and companion remain", async () => {
  const { box, onSend } = setupAttachmentComposer("Keep this caption");
  const badImage = new File(["plain text"], "broken.png", {
    type: "image/png",
  });
  const validFile = new File(["notes"], "notes.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose files to attach"), {
    target: { files: [badImage, validFile] },
  });
  expect((await screen.findByRole("alert")).textContent).toMatch(/image|PNG/i);
  expect(screen.getByRole("button", { name: "Retry broken.png" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove broken.png" }));
  expect(box).toHaveProperty("value", "Keep this caption");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith(
    "Keep this caption",
    [],
    [{ name: "notes.txt", dataUrl: "data:text/plain;base64,bm90ZXM=" }],
  );
});

test("an oversized pasted image blocks sending until it is removed", async () => {
  const onSend = vi.fn(async () => {});
  const draft = new ComposerAttachments((file) =>
    captureChatAttachment(file, 10),
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

test("sending by button clears the open mention menu with the draft", async () => {
  const { box, onSend } = setup();
  box.focus();
  type(box, "#rate");
  await screen.findByRole("option", { name: /T-KQ12/ });

  const send = screen.getByRole("button", { name: "Send" });
  send.focus();
  fireEvent.click(send);
  await waitFor(() => expect(box).toHaveProperty("value", ""));
  expect(box.readOnly).toBe(false);
  expect(onSend).toHaveBeenCalledWith("#rate", []);
  expect(screen.queryByRole("listbox")).toBeNull();

  box.focus();
  type(box, "#rate");
  expect(await screen.findByRole("option", { name: /T-KQ12/ })).toBeTruthy();
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

test("a locked save blocks token deletion until the composer is editable", async () => {
  const { box, onSend } = setup();
  let fail!: (error: Error) => void;
  const saving = new Promise<void>((_, reject) => {
    fail = reject;
  });
  onSend.mockReturnValueOnce(saving);
  type(box, "#rate");
  await screen.findByRole("option", { name: /T-KQ12/ });
  fireEvent.keyDown(box, { key: "Tab" });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(box).toHaveProperty("readOnly", true);
  box.setSelectionRange(6, 6);
  fireEvent.keyDown(box, { key: "Backspace" });
  expect(box.value).toBe("T-KQ12 ");
  expect(screen.queryByText("Removed T-KQ12.")).toBeNull();

  await act(async () => fail(new Error("Send failed")));
  expect(box).toHaveProperty("readOnly", false);
  box.setSelectionRange(6, 6);
  fireEvent.keyDown(box, { key: "Backspace" });
  expect(box.value).toBe(" ");
  expect(screen.getByText("Removed T-KQ12.")).toBeTruthy();
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

test("replacing a dismissed mention with another trigger opens its menu", async () => {
  const { box } = setup();
  type(box, "see @lim");
  expect(await screen.findByText("Files in api")).toBeTruthy();
  fireEvent.keyDown(box, { key: "Escape" });

  type(box, "see @limiter");
  expect(screen.queryByRole("listbox")).toBeNull();
  type(box, "see #rate");
  expect(await screen.findByRole("option", { name: /T-KQ12/ })).toBeTruthy();
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
