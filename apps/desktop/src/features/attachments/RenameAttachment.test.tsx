// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RenameAttachment } from "./RenameAttachment";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("rename preserves the draft and request identity after a lost response", async () => {
  const file = {
    id: "stable",
    display_name: "Trace",
    original_filename: "trace.log",
    size_bytes: 9,
    kind: "local_snapshot" as const,
    locator: "stable/bytes/trace.log",
  };
  const changed = vi.fn();
  vi.mocked(invoke)
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce({ ...file, display_name: "Readable trace" });
  render(
    <RenameAttachment file={file} onClose={() => {}} onRenamed={changed} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), {
    target: { value: "Readable trace" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("alert");
  const original = vi.mocked(invoke).mock.calls[0]?.[1];
  expect(
    (screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement)
      .value,
  ).toBe("Readable trace");
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith({
      ...file,
      display_name: "Readable trace",
    }),
  );
  expect(invoke).toHaveBeenLastCalledWith("rename_attachment", original);
});
