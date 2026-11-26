// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { syncReview, type Availability } from "@/lib/sync-review-api";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { useAvailability } from "./availability";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: { availability: vi.fn(), download: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Names({ id }: { id: string }) {
  const availability = useAvailability([id]);
  return <p>{`${id}: ${availability.of(id)?.state ?? "unknown"}`}</p>;
}
const cards = (version: number) => (
  <WorkspaceChangeProvider value={version}>
    <Names id="a" />
    <Names id="b" />
    <Names id="c" />
  </WorkspaceChangeProvider>
);

test("cards that ask in the same turn share one availability read, each seeing only its own file", async () => {
  const states: Availability[] = [
    { id: "a", state: "downloaded", progress: null },
    { id: "b", state: "not_downloaded", progress: null },
    { id: "c", state: "downloading", progress: 10 },
  ];
  vi.mocked(syncReview.availability).mockImplementation(async (ids) =>
    states.filter((item) => ids.includes(item.id)),
  );
  const view = render(cards(1));
  expect(await screen.findByText("b: not_downloaded")).toBeTruthy();
  expect(screen.getByText("a: downloaded")).toBeTruthy();
  expect(screen.getByText("c: downloading")).toBeTruthy();
  expect(syncReview.availability).toHaveBeenCalledTimes(1);
  expect(syncReview.availability).toHaveBeenCalledWith(["a", "b", "c"]);
  // A Workspace change asks again, once for all of them.
  vi.mocked(syncReview.availability).mockClear();
  states[1] = { id: "b", state: "downloaded", progress: null };
  await act(async () => {
    view.rerender(cards(2));
  });
  expect(await screen.findByText("b: downloaded")).toBeTruthy();
  expect(syncReview.availability).toHaveBeenCalledTimes(1);
});

test("a failed shared read fails each asker alone and leaves what it knew", async () => {
  vi.mocked(syncReview.availability).mockRejectedValue(new Error("offline"));
  render(cards(1));
  expect(await screen.findByText("a: unknown")).toBeTruthy();
  expect(syncReview.availability).toHaveBeenCalledTimes(1);
});
