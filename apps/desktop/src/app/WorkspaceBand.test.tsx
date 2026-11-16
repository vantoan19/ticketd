// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { structured } from "@/lib/api/bridge-failure";
import { clearWorkspaceFailure } from "@/lib/workspace-state";
import { WorkspaceBand } from "./WorkspaceBand";

afterEach(() => {
  cleanup();
  clearWorkspaceFailure();
});

const fail = (code: string) =>
  act(async () => {
    await structured(Promise.reject({ code, message: `raw ${code}` })).catch(
      () => {},
    );
  });
const succeed = () =>
  act(async () => {
    await structured(Promise.resolve(1));
  });

test("workspace failures remain visible across successful reads until recovery", async () => {
  render(<WorkspaceBand onRetry={() => {}} />);
  await fail("workspace_locked");
  expect(
    screen.getByText(/Another ticketd operation is using this workspace/),
  ).toBeTruthy();
  // The raw text waits under Details.
  expect(screen.queryByText("raw workspace_locked")).toBeNull();
  await succeed();
  expect(
    screen.getByText(/Another ticketd operation is using this workspace/),
  ).toBeTruthy();

  // Reads still succeed on a read-only workspace, so only Retry ends it.
  await fail("workspace_read_only");
  await succeed();
  expect(
    screen.getByText("This workspace is read-only. Changes can't be saved."),
  ).toBeTruthy();
  // An ordinary failure never raises the band.
  clearWorkspaceFailure();
  await fail("not_found");
  expect(screen.queryByRole("status")).toBeNull();
});
