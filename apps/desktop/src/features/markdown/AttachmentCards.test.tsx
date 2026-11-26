// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownDocument } from "./MarkdownDocument";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (value: string) =>
    `http://attachment-media.localhost/${value}`,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const log = {
  id: "log-1",
  display_name: "e2e-run-2026-11-25.log",
  original_filename: "e2e-run-2026-11-25.log",
  size_bytes: 2516582,
  kind: "local_snapshot" as const,
  locator: "log-1/bytes/e2e.log",
};
const report = {
  ...log,
  id: "report-1",
  display_name: "refund-e2e-report.html",
  original_filename: "refund-e2e-report.html",
  size_bytes: 190464,
};
const uri = (id: string) => `ticketd://attachment/workspace/${id}`;
function bridge() {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "resolve_attachment_uri") {
      const target = (args as { uri: string }).uri;
      return target.endsWith("report-1") ? report : log;
    }
    return null;
  });
}

test("a link alone on its line becomes a card; one in a sentence stays a link with its glyph", async () => {
  bridge();
  const source = [
    "The run is below, with the [e2e report](" +
      uri("report-1") +
      ") for details.",
    "",
    `[Run log](${uri("log-1")})`,
    "",
    `<${uri("report-1")}>`,
  ].join("\n");
  const { container } = render(
    <MarkdownDocument source={source} attachmentCards />,
  );
  // Alone on its line: a card, named by the authored label when it differs.
  await screen.findByText("Log · 2.4 MB");
  expect(screen.getByRole("button", { name: "Run log" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "refund-e2e-report.html" }),
  ).toBeTruthy();
  // The row of cards is a block of its own, never inside a paragraph.
  const rows = container.querySelectorAll("[data-cards]");
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.localName).toBe("div");
    expect(row.querySelector("button")?.closest("p")).toBeNull();
  }
  // In a sentence: words stay, with the file family's glyph in front.
  const link = screen.getByRole("button", { name: "e2e report" });
  expect(link.closest("p")?.hasAttribute("data-cards")).toBe(false);
  await vi.waitFor(() =>
    expect(link.querySelector("svg.attachment-link-glyph")).toBeTruthy(),
  );
});

test("a card opens the shared viewer on its exact reference", async () => {
  bridge();
  render(
    <MarkdownDocument source={`[Run log](${uri("log-1")})`} attachmentCards />,
  );
  await screen.findByText("Log · 2.4 MB");
  fireEvent.click(screen.getByRole("button", { name: "Run log" }));
  await screen.findByRole("dialog");
  expect(invoke).toHaveBeenCalledWith("resolve_attachment_uri", {
    uri: uri("log-1"),
  });
});

test("without cards, a lone link stays an ordinary link and resolves nothing", () => {
  render(<MarkdownDocument source={`[Run log](${uri("log-1")})`} />);
  expect(
    screen.getByRole("button", { name: "Run log" }).className,
  ).not.toContain("file-card");
  expect(invoke).not.toHaveBeenCalled();
});

test("a reference that can't be resolved stays a link", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("another workspace"));
  const { container } = render(
    <MarkdownDocument source={`[Run log](${uri("gone")})`} attachmentCards />,
  );
  await vi.waitFor(() =>
    expect(container.querySelector(".file-card")).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Run log" })).toBeTruthy();
});
