// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Projects } from "./Projects";

afterEach(cleanup);

test("keeps a project draft while adopting an untouched path from refresh", () => {
  const project = { id: "p1", name: "Original", path: "/old", paths: ["/old"] };
  const props = {
    projects: [project],
    loading: false,
    filter: "all",
    onFilter: () => {},
    onChange: async () => {},
  };
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
