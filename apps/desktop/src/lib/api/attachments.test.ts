// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { attachments } from "./attachments";

afterEach(clearMocks);

test("a text response may arrive as an array of bytes from the fallback transport", async () => {
  mockIPC(() => Array.from(new TextEncoder().encode("hé\n")));
  expect(await attachments.text("workspace", "id")).toBe("hé\n");
});

test("a PDF response keeps bytes as they are and rejects an array that is not bytes", async () => {
  mockIPC(() => new Uint8Array([37, 80, 68, 70]).buffer);
  expect([...(await attachments.pdf("workspace", "id"))]).toEqual([
    37, 80, 68, 70,
  ]);
  for (const bad of [[37, 256], [37, -1], [37, 1.5], [37, "P"], {}, "text"]) {
    mockIPC(() => bad);
    await expect(attachments.pdf("workspace", "id")).rejects.toThrow(
      "did not arrive as bytes",
    );
  }
});
