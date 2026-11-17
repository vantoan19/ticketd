// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => vi.fn<() => Promise<number>>());
vi.mock("@/lib/api/changes", () => ({ changesClient: { token } }));

import { read } from "./catalog";
import { useRead } from "./use-read";
import { useReplaced } from "./use-replaced";
import { WorkspaceReads } from "./WorkspaceReads";

// The real poll, against a token the test sets: what a replace does to the
// poll that follows it.
describe("the poll after a replaced Workspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    token.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["the token the old Workspace had", 1],
    ["another token", 9],
  ])("starts no second wave when the new Workspace has %s", async (_, next) => {
    token.mockResolvedValue(1);
    let n = 0;
    const call = vi.fn(async () => ++n);
    const spec = read({ key: `replaced-poll-${next}`, call, failure: "load" });
    const { result } = renderHook(
      () => ({ read: useRead(spec, null), replaced: useReplaced() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <WorkspaceReads>{children}</WorkspaceReads>
        ),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.read.value).toBe(1);

    token.mockResolvedValue(next);
    await act(async () => result.current.replaced());
    expect(result.current.read.value).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(2000));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(call).toHaveBeenCalledTimes(2);
  });
});
