// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsRow } from "@/features/settings/layout/SettingsList";

test("a row's title and description can hold a block, such as a loading skeleton", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { container } = render(
    <SettingsRow
      title={<Skeleton className="h-4 w-24" />}
      description={<Skeleton className="h-3 w-40" />}
    />,
  );
  expect(error).not.toHaveBeenCalled();
  expect(container.querySelector("p [data-slot='skeleton']")).toBeNull();
  error.mockRestore();
});

test("operating a control inside an openable row does not open the row, but the rest of the row does", () => {
  const onOpen = vi.fn();
  render(
    <SettingsRow
      title="Claude Code"
      onOpen={onOpen}
      openLabel="Open Claude Code"
      trailing={
        <>
          <select aria-label="Model">
            <option>One</option>
          </select>
          <textarea aria-label="Note" />
          <label>
            Remember <span>this</span>
          </label>
        </>
      }
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
  fireEvent.click(screen.getByRole("textbox", { name: "Note" }));
  fireEvent.click(screen.getByText("this"));
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Claude Code"));
  expect(onOpen).toHaveBeenCalledTimes(1);
});
