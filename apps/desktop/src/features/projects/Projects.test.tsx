// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { client } from "@/lib/api/client";
import { workspaceClient } from "@/lib/api/workspace";
import { StatusLineRegion } from "@/components/ui/status-line";
import { Projects } from "./Projects";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = {
  id: "p1",
  name: "Original",
  path: "/old",
  paths: ["/Users/me/src/old", "/other/checkout"],
};
const props = {
  projects: [project],
  loading: false,
  onChange: async () => {},
};

/** Opens a project row to its checkouts. */
function expand(name = "Original") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}
/** Chooses an item from a project's "…" menu. */
async function chooseAction(item: string, name = "Original") {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** Hovers an element and returns the text of the tooltip it opens. */
async function hoverTooltip(element: HTMLElement) {
  fireEvent.pointerMove(element);
  const text = (await screen.findByRole("tooltip")).textContent;
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  return text;
}

test("shows checkouts home-relative on one line with the full path on hover", async () => {
  render(<Projects {...props} />);
  expand();
  const list = screen.getByRole("list", { name: "Checkouts of Original" });
  const [first, second] = Array.from(
    list.querySelectorAll<HTMLElement>('[data-slot="path-text"]'),
  );
  expect(first!.textContent).toBe("~/src/old");
  expect(second!.textContent).toBe("/other/checkout");
  // The full path is in a tooltip (P4), not a native title.
  expect(list.querySelector("[title]")).toBeNull();
  expect(await hoverTooltip(first!)).toBe("/Users/me/src/old");
  expect(await hoverTooltip(second!)).toBe("/other/checkout");
});

test("labels the project's own path as the first checkout, not the alphabetically first", () => {
  render(
    <Projects
      {...props}
      projects={[{ ...project, path: "/zeta", paths: ["/eta", "/zeta"] }]}
    />,
  );
  expand();
  const list = screen.getByRole("list", { name: "Checkouts of Original" });
  const [eta, zeta] = within(list).getAllByRole("listitem");
  expect(eta?.textContent).not.toContain("First checkout");
  expect(zeta?.textContent).toContain("First checkout");
});

test("the New project hint does not promise dropping or name a macOS app", () => {
  render(<Projects {...props} projects={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  expect(screen.queryByText(/Finder|drop it/)).toBeNull();
});

test("copies a checkout path and the project ID, and shows the folder in the file manager", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const reveal = vi.spyOn(workspaceClient, "reveal").mockResolvedValue();
  render(<Projects {...props} />);
  // The command-line hint is said once, in the lede (plans PR-09).
  expect(screen.getByText(/picks it from the folder you're in/)).toBeTruthy();
  await chooseAction("Copy project ID");
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("p1"));
  expand();
  fireEvent.click(
    screen.getByRole("button", { name: "Copy path /other/checkout" }),
  );
  expect(writeText).toHaveBeenCalledWith("/other/checkout");
  const row = screen.getByText("/other/checkout").closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /^Show in / }));
  expect(reveal).toHaveBeenCalledWith("/other/checkout");
});

test("empty state explains and offers New project", () => {
  render(<Projects {...props} projects={[]} />);
  expect(screen.getByText(/No projects yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  expect(screen.getByRole("dialog", { name: "New project" })).toBeTruthy();
});

test("a new project waits for a folder, fills its name from it, then saves", async () => {
  vi.spyOn(workspaceClient, "chooseFolder").mockResolvedValue(
    "/Users/me/src/mobile-app",
  );
  const create = vi.spyOn(client, "createProject").mockResolvedValue(project);
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<Projects {...props} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  const dialog = screen.getByRole("dialog", { name: "New project" });
  const create_ = within(dialog).getByRole("button", {
    name: "Create project",
  });
  expect(create_).toHaveProperty("disabled", true);
  expect(within(dialog).getByText("No folder chosen")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose…" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Change…" }),
    ).toBeTruthy(),
  );
  expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveProperty(
    "value",
    "Mobile App",
  );
  expect(create_).toHaveProperty("disabled", false);
  fireEvent.click(create_);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      "Mobile App",
      "/Users/me/src/mobile-app",
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onChange).toHaveBeenCalled();
});

test("cancelling the folder picker keeps Create project disabled", async () => {
  const choose = vi
    .spyOn(workspaceClient, "chooseFolder")
    .mockResolvedValue(null);
  render(<Projects {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
  await waitFor(() => expect(choose).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("renames a project from its menu and shows a save failure in the dialog", async () => {
  vi.spyOn(client, "editProject").mockRejectedValue({
    code: "workspace_read_only",
    message: "workspace database error: attempt to write a readonly database",
  });
  render(<Projects {...props} />);
  // One "…" holds Rename, Copy project ID and Register checkout (PR-04).
  await chooseAction("Rename…");
  const dialog = await screen.findByRole("dialog", { name: "Rename project" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain(
    "Couldn't rename the project. The workspace is read-only, so nothing changed.",
  );
  // The raw text stays under Details, and the valid name is not marked invalid (PR-05).
  expect(alert.textContent).not.toContain("readonly database");
  expect(
    within(dialog).getByLabelText("Project name").getAttribute("aria-invalid"),
  ).toBeNull();
});

test("registers a checkout by choosing a folder", async () => {
  vi.spyOn(workspaceClient, "chooseFolder").mockResolvedValue("/work/tree");
  const register = vi
    .spyOn(client, "registerCheckout")
    .mockResolvedValue(project);
  render(<Projects {...props} />);
  await chooseAction("Register checkout…");
  const dialog = await screen.findByRole("dialog", {
    name: "Register checkout",
  });
  const submit = within(dialog).getByRole("button", {
    name: "Register checkout",
  });
  expect(submit).toHaveProperty("disabled", true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose…" }));
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  fireEvent.click(submit);
  await waitFor(() =>
    expect(register).toHaveBeenCalledWith("p1", "/work/tree"),
  );
});

test("removing a checkout acts at once and Undo registers it again", async () => {
  // Plans PR-01: no inline confirmation pushing the page down.
  const remove = vi.spyOn(client, "removeCheckout").mockResolvedValue(project);
  const register = vi
    .spyOn(client, "registerCheckout")
    .mockResolvedValue(project);
  render(
    <StatusLineRegion>
      <Projects {...props} />
    </StatusLineRegion>,
  );
  expand();
  const row = screen.getByText("/other/checkout").closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Remove checkout" }));
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith("p1", "/other/checkout"),
  );
  expect(await screen.findByText("Removed checkout checkout")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(register).toHaveBeenCalledWith("p1", "/other/checkout"),
  );
});

test("opens the tickets of a project from its row", () => {
  const onOpenTickets = vi.fn();
  render(<Projects {...props} onOpenTickets={onOpenTickets} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open tickets of Original" }),
  );
  expect(onOpenTickets).toHaveBeenCalledWith(project);
});

test("says how many tickets have no project and shows them", async () => {
  vi.spyOn(client, "countTickets").mockImplementation(
    async (filter) =>
      ({
        total: filter.unlinked ? 4 : 1,
        done: 0,
        canceled: 0,
        duplicate: 0,
      }) as Awaited<ReturnType<typeof client.countTickets>>,
  );
  const onShowUnassigned = vi.fn();
  render(<Projects {...props} onShowUnassigned={onShowUnassigned} />);
  expect(await screen.findByText(/4 tickets have no project/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show them" }));
  expect(onShowUnassigned).toHaveBeenCalled();
});

test("a long checkout path keeps all its text for the middle to truncate", () => {
  const long =
    "/private/tmp/claude-501/-Users-me-Projects/8b654d0c-8f7d/repo-api";
  render(<Projects {...props} projects={[{ ...project, paths: [long] }]} />);
  expand();
  const path = document.querySelector('[data-slot="path-text"]');
  expect(path?.textContent).toBe(long);
});
