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
import { Projects } from "./Projects";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = {
  id: "p1",
  name: "Original",
  path: "/old",
  paths: ["/old", "/other/checkout"],
};
const props = {
  projects: [project],
  loading: false,
  filter: "all",
  onFilter: () => {},
  onChange: async () => {},
};

test("keeps a project draft while adopting an untouched path from refresh", () => {
  const { rerender } = render(<Projects {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Original" }));
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "Draft" },
  });
  rerender(<Projects {...props} projects={[{ ...project, path: "/new" }]} />);
  expect(screen.getByLabelText("Project name")).toHaveProperty(
    "value",
    "Draft",
  );
  expect(screen.getByLabelText("Repository path")).toHaveProperty(
    "value",
    "/new",
  );
});

test("shows the explanation, project ID and checkouts with Copy actions", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  render(<Projects {...props} />);
  expect(screen.getByText(/identity survives moves and renames/)).toBeTruthy();
  expect(screen.getByText("p1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Copy project ID/ }));
  expect(writeText).toHaveBeenCalledWith("p1");
  fireEvent.click(
    screen.getByRole("button", { name: "Copy checkout path /other/checkout" }),
  );
  expect(writeText).toHaveBeenCalledWith("/other/checkout");
});

test("empty state explains and offers New project", () => {
  render(<Projects {...props} projects={[]} />);
  expect(screen.getByText(/No projects yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  expect(screen.getByRole("dialog", { name: "New project" })).toBeTruthy();
});

test("validates a new project inline before saving", async () => {
  const create = vi.spyOn(client, "createProject");
  render(<Projects {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(screen.getByText("Enter a project name.")).toBeTruthy();
  expect(screen.getByText("Enter a repository path.")).toBeTruthy();
  expect(
    screen.getByLabelText("Project name").getAttribute("aria-invalid"),
  ).toBe("true");
  expect(create).not.toHaveBeenCalled();
});

test("creates a project, refreshes, and closes the dialog", async () => {
  const create = vi.spyOn(client, "createProject").mockResolvedValue(project);
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<Projects {...props} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: " New " },
  });
  fireEvent.change(screen.getByLabelText("Repository path"), {
    target: { value: "/repo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("New", "/repo"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onChange).toHaveBeenCalled();
});

test("shows a save failure inside the dialog and keeps it open", async () => {
  vi.spyOn(client, "editProject").mockRejectedValue("Name already used");
  render(<Projects {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Original" }));
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  expect(await within(dialog).findByText("Name already used")).toBeTruthy();
});

test("registers a checkout from a dialog with inline validation", async () => {
  const register = vi
    .spyOn(client, "registerCheckout")
    .mockResolvedValue(project);
  render(<Projects {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Register checkout for Original" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Register checkout",
    }),
  );
  expect(screen.getByText("Enter a checkout path.")).toBeTruthy();
  expect(register).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Checkout path"), {
    target: { value: "/work/tree" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Register checkout",
    }),
  );
  await waitFor(() =>
    expect(register).toHaveBeenCalledWith("p1", "/work/tree"),
  );
});

test("removing a checkout asks first and says tickets are unchanged", async () => {
  const remove = vi.spyOn(client, "removeCheckout").mockResolvedValue(project);
  render(<Projects {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove checkout /other/checkout" }),
  );
  expect(remove).not.toHaveBeenCalled();
  const confirm = screen.getByRole("group", {
    name: "Remove checkout /other/checkout",
  });
  expect(within(confirm).getByText(/tickets are unchanged/)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove checkout /other/checkout" }),
  );
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Remove checkout /other/checkout" }),
    ).getByRole("button", { name: "Remove checkout" }),
  );
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith("p1", "/other/checkout"),
  );
});
