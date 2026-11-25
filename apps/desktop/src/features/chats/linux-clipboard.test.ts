// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { readLinuxClipboardImage, redactedLinuxPaste } from "./linux-clipboard";

test("the Linux image fallback is limited to an empty DOM clipboard", () => {
  const payload = (types: string[], items = 0, files = 0, text = "") =>
    ({
      types,
      items: { length: items },
      files: { length: files },
      getData: (format: string) => (format === "text/plain" ? text : ""),
    }) as unknown as DataTransfer;
  expect(redactedLinuxPaste(payload([]))).toBe(true);
  expect(redactedLinuxPaste(payload(["text/plain"]))).toBe(false);
  expect(redactedLinuxPaste(payload(["text/uri-list"]))).toBe(false);
  expect(redactedLinuxPaste(payload([], 1))).toBe(false);
  expect(redactedLinuxPaste(payload([], 0, 1))).toBe(false);
  expect(redactedLinuxPaste(payload([], 0, 0, "/work/notes.txt"))).toBe(false);
});

test("the Linux chooser's reply reaches only the paste that requested it", async () => {
  const picker = document.createElement("input");
  let id = "";
  const deliver = (id: string, name: string) =>
    window.dispatchEvent(
      new CustomEvent("ticketd-clipboard-image", {
        detail: {
          id,
          attachment: { name, dataUrl: "data:image/png;base64,YWJj" },
        },
      }),
    );
  picker.showPicker = vi.fn(() => {
    id = picker.accept.replace("application/x-ticketd-clipboard-image-", "");
    deliver("past-request", "wrong.png");
    deliver(id, "Screenshot.png");
  });
  await expect(readLinuxClipboardImage(picker)).resolves.toEqual({
    name: "Screenshot.png",
    dataUrl: "data:image/png;base64,YWJj",
  });
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(picker.showPicker).toHaveBeenCalledOnce();
});
