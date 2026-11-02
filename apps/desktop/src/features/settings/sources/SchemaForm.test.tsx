// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SchemaForm } from "@/features/settings/sources/SchemaForm";
import type { SchemaField } from "@/lib/api/sources";

const multi = (key: string, label: string): SchemaField => ({
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
