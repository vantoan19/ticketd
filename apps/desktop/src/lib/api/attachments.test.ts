import { expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { attachments } from "./attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (value: unknown) => void = () => {};
    toJSON() {
      return "channel";
    }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

test("a file over the upload limit is refused with a way forward the app offers", async () => {
  vi.mocked(invoke).mockResolvedValue(1024);
  const file = new File([new Uint8Array(2048)], "big.png");
  const refusal = await attachments
    .upload(file, "request-1", () => {})
    .catch((reason: unknown) => reason);
  expect(refusal).toBeInstanceOf(Error);
  const message = (refusal as Error).message;
  expect(message).toContain("upload limit");
  // Settings › Files has no limit control, so it cannot be the advice.
  expect(message).not.toContain("Settings");
  expect(message).toContain("smaller file");
});
