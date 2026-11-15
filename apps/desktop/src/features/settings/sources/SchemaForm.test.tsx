// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SchemaForm } from "@/features/settings/sources/SchemaForm";
import type { SchemaField } from "@/lib/api/sources";

const multi = (
  key: string,
  label: string,
): Extract<SchemaField, { type: "multi_select" }> => ({
  key,
  label,
  required: false,
  type: "multi_select",
  options: { source: "static", options: [{ value: "one", label: "One" }] },
  allow_custom: false,
  min_items: 0,
  max_items: 3,
  format: null,
});
const fields = [
  multi("repositories", "Repositories"),
  multi("labels", "Labels"),
];

afterEach(() => cleanup());

function form(onChange = vi.fn()) {
  render(
    <>
      <SchemaForm
        fields={fields}
        draft={{ repositories: [], labels: [] }}
        errors={{}}
        disabled={false}
        loadOptions={async () => []}
        onChange={onChange}
      />
      <button type="button">Save</button>
    </>,
  );
  return onChange;
}

const input = (name: string) =>
  screen.getByRole("textbox", { name: new RegExp(`^${name}`) });
const list = (name: string) =>
  screen.queryByLabelText(`${name} suggestions`, { selector: "div" });

test("Escape closes the suggestion list", () => {
  form();
  fireEvent.focus(input("Repositories"));
  expect(list("Repositories")).not.toBeNull();
  fireEvent.keyDown(input("Repositories"), { key: "Escape" });
  expect(list("Repositories")).toBeNull();
});

test("choosing a value closes the list", () => {
  const onChange = form();
  fireEvent.focus(input("Repositories"));
  fireEvent.click(screen.getByRole("button", { name: "Add One" }));
  expect(onChange).toHaveBeenCalledWith("repositories", ["one"]);
  expect(list("Repositories")).toBeNull();
});

test("only one list is open at a time", () => {
  form();
  fireEvent.focus(input("Repositories"));
  fireEvent.focus(input("Labels"));
  expect(list("Repositories")).toBeNull();
  expect(list("Labels")).not.toBeNull();
});

test("pressing outside the field, such as Save, closes the list", () => {
  form();
  fireEvent.focus(input("Repositories"));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Save" }));
  expect(list("Repositories")).toBeNull();
});

test("text typed but not added says what is wrong instead of 'are required'", () => {
  const repositories: SchemaField = {
    ...multi("repositories", "Repositories"),
    required: true,
    allow_custom: true,
    format: "owner_name",
  };
  render(
    <SchemaForm
      fields={[repositories]}
      draft={{ repositories: [] }}
      errors={{ repositories: ["are required"] }}
      disabled={false}
      loadOptions={async () => []}
      onChange={vi.fn()}
    />,
  );
  fireEvent.change(input("Repositories"), { target: { value: "not a repo" } });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("“not a repo” is not a repository");
  expect(alert.textContent).toContain("owner/name");
  expect(screen.queryByText(/are required/)).toBeNull();
});

test("Enter refuses a repository that is not owner/name, keeps the text and sends nothing", () => {
  const repositories: SchemaField = {
    ...multi("repositories", "Repositories"),
    allow_custom: true,
    format: "owner_name",
  };
  const onChange = vi.fn();
  render(
    <SchemaForm
      fields={[repositories]}
      draft={{ repositories: [] }}
      errors={{}}
      disabled={false}
      loadOptions={async () => []}
      onChange={onChange}
    />,
  );
  const field = input("Repositories") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "acme billing" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  expect(field.value).toBe("acme billing");
  expect(screen.getByRole("alert").textContent).toBe(
    "Use owner/name, for example acme/billing-api.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(field, { target: { value: "acme/billing" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("repositories", ["acme/billing"]);
});
