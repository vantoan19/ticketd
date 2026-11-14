// @vitest-environment jsdom
import { render } from "@testing-library/react";
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
