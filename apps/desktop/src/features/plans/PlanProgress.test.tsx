// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PlanRing, PlanSplitBar } from "./PlanProgress";

afterEach(cleanup);

test("Plan progress names countable work and moving tickets from authoritative counts", () => {
  const counts = {
    todo: 3,
    in_progress: 1,
    in_review: 1,
    done: 2,
    canceled: 8,
    duplicate: 4,
  };
  render(
    <>
      <PlanRing name="Board polish" counts={counts} />
      <PlanSplitBar name="Board polish" counts={counts} />
    </>,
  );
  expect(
    screen.getAllByRole("img", { name: "Board polish, 2 of 7 done, 2 moving" }),
  ).toHaveLength(2);
});

for (const counts of [
  { todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0, duplicate: 0 },
  { todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 3, duplicate: 2 },
]) {
  test(`empty countable work is not completed (${counts.canceled} canceled)`, () => {
    render(
      <>
        <PlanRing name="Empty Plan" counts={counts} />
        <PlanSplitBar name="Empty Plan" counts={counts} />
      </>,
    );
    expect(
      screen.getAllByRole("img", { name: "Empty Plan, 0 of 0 done, 0 moving" }),
    ).toHaveLength(2);
  });
}

test("Done does not count as moving and decorative progress is silent", () => {
  const counts = {
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 5,
    canceled: 1,
    duplicate: 1,
  };
  const { rerender } = render(
    <>
      <PlanRing name="Finished" counts={counts} size={20} />
      <PlanSplitBar name="Finished" counts={counts} />
    </>,
  );
  expect(
    screen.getAllByRole("img", { name: "Finished, 5 of 5 done, 0 moving" }),
  ).toHaveLength(2);
  rerender(
    <>
      <PlanRing name="Finished" counts={counts} decorative />
      <PlanSplitBar name="Finished" counts={counts} decorative />
    </>,
  );
  expect(screen.queryByRole("img")).toBeNull();
});
