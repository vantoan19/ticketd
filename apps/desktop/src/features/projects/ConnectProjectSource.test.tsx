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

Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const preview = {
  project_id: "p1",
  project_remote: "github.com/team/app",
  provider: "github",
  connection_id: "github",
  repository: "team/app",
  source: "add_repository",
  tickets: ["T-ABCDE", "T-FGHJK"],
  fingerprint: "reviewed",
};

const candidate = {
  source: "github",
  provider: "github",
  connection_id: "github",
  name: "GitHub",
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
      if (command === "project_source_candidates") return [candidate];
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
                source: "github",
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
    if (command === "project_source_candidates") return [candidate];
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
    source: "github",
    projectId: "p1",
    expectedFingerprint: "updated",
  });
});

test("a failed match count offers details and retries without connecting", async () => {
  let countFailed = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "project_source_candidates") return [candidate];
    if (command === "preview_connect_source") return preview;
    if (command === "connect_source_match_count") {
      if (countFailed) return { matched: 4, complete: true };
      countFailed = true;
      throw { code: "unavailable", message: "GitHub has timed out" };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  render(<Review />);
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't count matching issues",
  );
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("GitHub has timed out")).toBeTruthy();
  fireEvent.click(retry);
  expect(
    await screen.findByText("Import issues from github.com/team/app (4 match)"),
  ).toBeTruthy();
});

test("changing projects disables confirmation until the new effect is reviewed", async () => {
  const second = {
    ...preview,
    project_id: "p2",
    source: "already_listed",
    fingerprint: "second",
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "project_source_candidates") return [candidate];
    if (command === "preview_connect_source") {
      if (args && "projectId" in args && args.projectId === "p2") return second;
      return { ...preview, source: "already_listed" };
    }
    return { repository_added: false, linked_tickets: second.tickets };
  });
  const dialog = (projectId: string) => (
    <ConnectProjectSource
      projectId={projectId}
      onClose={() => {}}
      onConnected={() => {}}
      onSetup={() => {}}
    />
  );
  const view = render(dialog("p1"));
  await screen.findByRole("button", { name: "Confirm" });
  view.rerender(dialog("p2"));
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("connect_source", {
      source: "github",
      projectId: "p2",
      expectedFingerprint: "second",
    }),
  );
});

test("a host mismatch names the remote and hands off to editing after the dialog closes", async () => {
  vi.mocked(invoke).mockRejectedValue({
    code: "project_source_host_mismatch",
    message:
      "Project remote enterprise.test/team/app is on a different host from the GitHub source. Select a remote on the source's host to connect it.",
  });
  const edit = vi.fn();
  render(
    <ConnectProjectSource
      projectId="p1"
      onClose={() => {}}
      onConnected={() => {}}
      onSetup={() => {}}
      onEditRemote={edit}
    />,
  );
  const action = await screen.findByRole("button", {
    name: "Edit Project remote",
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "enterprise.test/team/app is on a different host",
  );
  fireEvent.click(action);
  await waitFor(() => expect(edit).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the selected connection supplies the reviewed count and confirmation", async () => {
  const selected = {
    ...candidate,
    source: "github-2",
    connection_id: "github-2",
    name: "Work GitHub",
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "project_source_candidates") return [candidate, selected];
    if (command === "preview_connect_source")
      return { ...preview, connection_id: selected.connection_id };
    if (command === "connect_source_match_count")
      return { matched: 4, complete: true };
    return { repository_added: true, linked_tickets: preview.tickets };
  });
  render(<Review />);
  const picker = await screen.findByRole("combobox", {
    name: "Source connection",
  });
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  fireEvent.keyDown(picker, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: selected.name }));
  await screen.findByText("Import issues from github.com/team/app (4 match)");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(invoke).toHaveBeenCalledWith("preview_connect_source", {
    source: "github-2",
    projectId: "p1",
  });
  for (const command of ["connect_source_match_count", "connect_source"]) {
    expect(invoke).toHaveBeenCalledWith(command, {
      source: "github-2",
      projectId: "p1",
      expectedFingerprint: "reviewed",
    });
  }
});

test("a new GitHub repository opens its host-aware Settings editor before backfill", async () => {
  const onSetup = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "project_source_candidates")
      return [{ ...candidate, connection_id: null }];
    if (command === "preview_connect_source")
      return {
        ...preview,
        connection_id: null,
        project_remote: "enterprise.test/team/app",
      };
    throw new Error(`Unexpected command ${command}`);
  });
  render(
    <ConnectProjectSource
      projectId="p1"
      onClose={() => {}}
      onConnected={() => {}}
      onSetup={onSetup}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Add repository…" }),
  );
  await waitFor(() =>
    expect(onSetup).toHaveBeenCalledWith({
      provider: "github",
      repository: "enterprise.test/team/app",
      projectId: "p1",
    }),
  );
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "project_source_candidates",
    "preview_connect_source",
  ]);
});
