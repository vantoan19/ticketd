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
import { AttachmentSettings } from "./AttachmentSettings";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("shows the core workspace limit and applies a new limit immediately with visible save failures", async () => {
  vi.mocked(invoke).mockResolvedValue(104857600);
  render(<AttachmentSettings />);
  const input = await screen.findByRole("spinbutton", {
    name: "Upload limit (MiB)",
  });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("100"));
  fireEvent.change(input, { target: { value: "25" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_attachment_upload_limit", {
      bytes: 26214400,
    }),
  );
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Workspace is read-only"));
  fireEvent.change(input, { target: { value: "30" } });
  fireEvent.blur(input);
  await screen.findByText(/Workspace is read-only/);
  expect((input as HTMLInputElement).value).toBe("30");
});
