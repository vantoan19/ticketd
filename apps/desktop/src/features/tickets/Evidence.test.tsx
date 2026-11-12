// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Evidence } from "./Evidence";

afterEach(cleanup);

vi.mock("@tauri-apps/api/core", () => {
  let items: unknown[] = [];
  return {
    invoke: vi.fn(
      async (command: string, args: { input?: object; id?: string }) => {
        if (command === "list_evidence") return items;
        if (command === "add_evidence") {
          const item = {
            ...args.input,
            id: "1",
            created_at: "now",
            updated_at: "now",
          };
          items = [item];
          return item;
        }
        if (command === "delete_evidence") {
          items = [];
          return;
        }
      },
    ),
  };
});
test("adds and removes a verification result", async () => {
  const view = render(
    <Evidence
      reference="T-KQ1"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  Element.prototype.scrollIntoView = vi.fn();
  expect(screen.queryByLabelText(/^Type: /)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: /^Type: / }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: /^Verification/ }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Tests" },
  });
  fireEvent.change(screen.getByLabelText("What was checked and its outcome"), {
    target: { value: "Unit tests passed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  expect(await screen.findByText("Unit tests passed")).toBeTruthy();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Actions for Tests" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete evidence" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Unit tests passed")).toBeNull(),
  );
  view.unmount();
});

test("retries a lost response with the same request ID and uses a new ID for a different submission", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const mock = vi.mocked(invoke);
  mock.mockClear();
  let first = true;
  mock.mockImplementation(async (command, args) => {
    if (command === "list_evidence") return [];
    if (command === "add_evidence") {
      if (first) {
        first = false;
        throw new Error("response lost");
      }
      return {
        ...(args as { input: object }).input,
        id: "new",
        created_at: "now",
        updated_at: "now",
      };
    }
  });
  const view = render(
    <Evidence
      reference="T-KQ2"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR" } });
  fireEvent.change(screen.getByLabelText("URL, reference, or path"), {
    target: { value: "https://example.com/pr" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  await waitFor(() =>
    expect(
      mock.mock.calls.filter(([name]) => name === "add_evidence"),
    ).toHaveLength(2),
  );
  const calls = mock.mock.calls.filter(([name]) => name === "add_evidence");
  expect((calls[0]?.[1] as { requestId: string }).requestId).toBe(
    (calls[1]?.[1] as { requestId: string }).requestId,
  );
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Other" },
  });
  fireEvent.change(screen.getByLabelText("URL, reference, or path"), {
    target: { value: "https://example.com/other" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  await waitFor(() =>
    expect(
      mock.mock.calls.filter(([name]) => name === "add_evidence"),
    ).toHaveLength(3),
  );
  expect(
    (
      mock.mock.calls.filter(([name]) => name === "add_evidence")[2]?.[1] as {
        requestId: string;
      }
    ).requestId,
  ).not.toBe((calls[0]?.[1] as { requestId: string }).requestId);
  view.unmount();
});

test("disables evidence controls while a write is pending", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const mock = vi.mocked(invoke);
  mock.mockReset();
  let complete: (value: unknown) => void = () => {};
  mock.mockImplementation(async (command) => {
    if (command === "list_evidence") return [];
    if (command === "add_evidence")
      return new Promise((resolve) => {
        complete = resolve;
      });
  });
  const view = render(
    <Evidence
      reference="T-KQ3"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR" } });
  fireEvent.change(screen.getByLabelText("URL, reference, or path"), {
    target: { value: "https://example.com/pr" },
  });
  const button = screen.getByRole("button", { name: "Add evidence" });
  fireEvent.click(button);
  expect(button.matches(":disabled")).toBe(true);
  fireEvent.click(button);
  expect(
    mock.mock.calls.filter(([name]) => name === "add_evidence"),
  ).toHaveLength(1);
  complete({
    id: "one",
    name: "PR",
    value: "https://example.com/pr",
    kind: "pull_request",
    editing_agent: null,
    created_at: "now",
    updated_at: "now",
  });
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  view.unmount();
});

test("copies any evidence value on explicit request", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_evidence")
      return [
        {
          id: "pr",
          kind: "pull_request",
          name: "Review",
          value: "https://example.com/pr/1",
          editing_agent: null,
          created_at: "now",
          updated_at: "now",
        },
      ];
  });
  const view = render(
    <Evidence
      reference="T-KQ4"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Copy Review" }));
  expect(copy).toHaveBeenCalledWith("https://example.com/pr/1");
  await screen.findByText("Copied");
  view.unmount();
  Reflect.deleteProperty(navigator, "clipboard");
});

test("a full commit hash is shown short, with the whole value on hover", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const full = "0123456789abcdef0123456789abcdef01234567";
  vi.mocked(invoke).mockImplementation(async (command: string) =>
    command === "list_evidence"
      ? [
          {
            id: "c1",
            kind: "commit",
            name: "Fix",
            value: full,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            editing_agent: null,
          },
        ]
      : undefined,
  );
  render(
    <Evidence
      reference="T-KQ2"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  const value = await screen.findByText("0123456789");
  expect(value.getAttribute("title")).toBe(full);
});

test("Add evidence stays disabled with its reason until name and evidence are filled", () => {
  render(
    <Evidence
      reference="T-KQ1"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  const primary = screen.getByRole("button", { name: "Add evidence" });
  expect(primary).toHaveProperty("disabled", true);
  expect(screen.getByText("Add a name to continue")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR" } });
  expect(screen.getByText("Add the evidence to continue")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("URL, reference, or path"), {
    target: { value: "https://example.com/pr" },
  });
  expect(primary).toHaveProperty("disabled", false);
});

test("Cancel discards the draft but Escape keeps it", async () => {
  render(
    <Evidence
      reference="T-KQ1"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Draft name" },
  });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Draft name",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
});
