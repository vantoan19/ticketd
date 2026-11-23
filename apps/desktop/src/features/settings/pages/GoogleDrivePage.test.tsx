// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GoogleDrivePage } from "@/features/settings/pages/GoogleDrivePage";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";
import { attachments } from "@/lib/api/attachments";

vi.mock("@/lib/api/attachments", () => ({
  attachments: { driveConfiguration: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function show(openPage = vi.fn()) {
  const state: SettingsState = {
    query: "",
    setQuery: () => {},
    openPage,
    needsSetup: {},
    refreshIndicators: () => {},
  };
  render(
    <SettingsStateContext value={state}>
      <GoogleDrivePage />
    </SettingsStateContext>,
  );
  return openPage;
}

test("the Google Drive page is about attachments and points to Attachments and Workspace sync", () => {
  vi.mocked(attachments.driveConfiguration).mockResolvedValue({
    configured: true,
    message: "",
  });
  const openPage = show();
  expect(
    screen.getByRole("heading", { level: 1, name: "Google Drive" }),
  ).toBeTruthy();
  expect(screen.getByText("Attach from Drive")).toBeTruthy();
  // Syncing the Workspace is not on this page any more.
  expect(
    screen.queryByRole("button", { name: /Connect Google Drive/ }),
  ).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open Attachments" }));
  expect(openPage).toHaveBeenLastCalledWith("attachments");
  fireEvent.click(screen.getByRole("button", { name: "Open Workspace sync" }));
  expect(openPage).toHaveBeenLastCalledWith("workspace-sync");
});

test("a build without a Drive app configuration says so", async () => {
  vi.mocked(attachments.driveConfiguration).mockResolvedValue({
    configured: false,
    message: "This build does not include Drive.",
  });
  show();
  expect(
    await screen.findByText("Google Drive isn't set up on this computer."),
  ).toBeTruthy();
});
