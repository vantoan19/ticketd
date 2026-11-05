// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceChangeProvider,
  useOnWorkspaceChange,
} from "./workspace-change";

describe("useOnWorkspaceChange", () => {
  it("delivers a change made while disabled once enabled again (H2)", () => {
    const callback = vi.fn();
    let version = 0;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkspaceChangeProvider value={version}>
        {children}
      </WorkspaceChangeProvider>
    );
    const { rerender } = renderHook(
      ({ enabled }) => useOnWorkspaceChange(callback, enabled),
      { initialProps: { enabled: false }, wrapper },
    );
    version = 1;
    rerender({ enabled: false });
    expect(callback).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
