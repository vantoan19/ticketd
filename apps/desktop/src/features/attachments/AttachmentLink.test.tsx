// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("reading keeps authored attachment text inline and resolves only on explicit inspection", async () => {
  const uri = "ticketd://attachment/owning-workspace/file-1";
  vi.mocked(invoke).mockResolvedValue({
    id: "file-1",
    display_name: "Renamed trace",
    original_filename: "trace.log",
    size_bytes: 12,
    kind: "local_snapshot",
    locator: "file-1/bytes/trace.log",
  });
  render(
    <MarkdownDocument source={`Before [My custom label](${uri}) after.`} />,
  );
  const link = screen.getByRole("button", { name: "My custom label" });
  expect(link.closest("p")?.textContent).toBe("Before My custom label after.");
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(link);
  await screen.findByRole("heading", { name: "Renamed trace" });
  expect(invoke).toHaveBeenCalledWith("resolve_attachment_uri", { uri });
  expect(screen.getByRole("button", { name: "Open file" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("button", { name: "My custom label" }).textContent,
  ).toBe("My custom label");
});

test("foreign or unavailable image references keep the label and actionable error", async () => {
  vi.mocked(invoke).mockRejectedValue(
    new Error("This link belongs to another workspace"),
  );
  render(
    <MarkdownDocument source="![Screenshot](ticketd://attachment/foreign/file)" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "another workspace",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("button", { name: "Screenshot" })).toBeTruthy();
});
