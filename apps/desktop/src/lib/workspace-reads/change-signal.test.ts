// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => vi.fn<() => Promise<number>>());
vi.mock("@/lib/api/changes", () => ({ changesClient: { token } }));

import { pollWorkspaceChanges } from "./change-signal";

describe("pollWorkspaceChanges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    token.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("reports only a token that moved, every two seconds, and stops with its last subscriber", async () => {
    token.mockResolvedValue(1);
    const signal = pollWorkspaceChanges();
    const onChange = vi.fn();
    const stop = signal.subscribe(onChange);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).not.toHaveBeenCalled();

    token.mockResolvedValue(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    const calls = token.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(token).toHaveBeenCalledTimes(calls);
  });

  it("counts a token read by catchUp as seen, so the next poll starts no second wave", async () => {
    token.mockResolvedValue(1);
    const signal = pollWorkspaceChanges();
    const onChange = vi.fn();
    signal.subscribe(onChange);
    await vi.advanceTimersByTimeAsync(0);

    token.mockResolvedValue(2);
    await signal.catchUp();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a poll answer that arrives after a newer catchUp", async () => {
    token.mockResolvedValue(1);
    const signal = pollWorkspaceChanges();
    const onChange = vi.fn();
    signal.subscribe(onChange);
    await vi.advanceTimersByTimeAsync(0);

    let late!: (value: number) => void;
    token.mockReturnValueOnce(new Promise<number>((ok) => (late = ok)));
    await vi.advanceTimersByTimeAsync(2000); // a poll is now waiting for its answer
    token.mockResolvedValue(2);
    await signal.catchUp();
    late(1); // the old answer, from before the write
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});
