// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ConfirmLeaveDuplicate } from "./ConfirmLeaveDuplicate";

afterEach(cleanup);

test("the confirm opens on Keep duplicate and its action is destructive", async () => {
  render(
    <ConfirmLeaveDuplicate
      canonical="T-KQ10"
      status="todo"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      returnFocus={createRef()}
    />,
  );
  const keep = screen.getByRole("button", { name: "Keep duplicate" });
  await waitFor(() => expect(document.activeElement).toBe(keep));
  expect(
    screen.getByRole("button", { name: "Change status" }).dataset.variant,
  ).toBe("destructive");
});
