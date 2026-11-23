// @vitest-environment jsdom
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ConnectProjectSource } from "./ConnectProjectSource";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const preview = {
  project_id: "p1",
  project_remote: "github.com/team/app",
  provider: "github",
  repository: "team/app",
  source: "add_repository",
  tickets: ["T-ABCDE", "T-FGHJK"],
  fingerprint: "reviewed",
};

function Review() {
  const [open, setOpen] = useState(true);
  return open ? (
    <ConnectProjectSource
      projectId="p1"
      onClose={() => setOpen(false)}
      onConnected={() => {}}
      onSetup={() => {}}
    />
  ) : null;
}

test.each(["Confirm", "Skip"])(
  "%s closes the reviewed project connection",
  async (action) => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "preview_connect_source") return preview;
      if (command === "connect_source_match_count")
        return { matched: 17, complete: false };
      return { repository_added: true, linked_tickets: preview.tickets };
    });
    render(<Review />);
    await screen.findByText(
      "Import issues from github.com/team/app (at least 17 match)",
    );
    expect(screen.getByText("Link 2 existing tickets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const writes = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "connect_source");
    expect(writes).toEqual(
      action === "Confirm"
        ? [
            [
              "connect_source",
              {
                provider: "github",
                projectId: "p1",
                expectedFingerprint: "reviewed",
              },
            ],
          ]
        : [],
    );
  },
);

test("a changed connection effect requires a new confirmation", async () => {
  let current = preview;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_connect_source") return current;
    if (command === "connect_source_match_count")
      return { matched: 3, complete: true };
    if (current.fingerprint === "reviewed") {
      current = { ...preview, tickets: ["T-ABCDE"], fingerprint: "updated" };
      throw { code: "conflict", message: "The connection preview changed." };
    }
    return { repository_added: true, linked_tickets: current.tickets };
  });
  render(<Review />);
  await screen.findByText("Import issues from github.com/team/app (3 match)");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText("Link 1 existing ticket");
  await screen.findByText("Import issues from github.com/team/app (3 match)");
  expect(screen.getByRole("alert").textContent).toContain(
    "Review the updated changes before confirming",
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "connect_source"),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(invoke).toHaveBeenCalledWith("connect_source", {
    provider: "github",
    projectId: "p1",
    expectedFingerprint: "updated",
  });
});
