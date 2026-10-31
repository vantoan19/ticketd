// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { client } from "@/lib/api/client";
import { useBulkEdit } from "./useBulkEdit";

afterEach(() => vi.restoreAllMocks());

test("a retry of the same bulk change reuses its request ID", async () => {
  const bulkStatus = vi
    .spyOn(client, "bulkStatus")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined as never);
  const { result } = renderHook(() => useBulkEdit(async () => {}));
  act(() => result.current.toggle("T-1"));
  act(() => result.current.setStatus("Done"));
  await act(() => result.current.applyStatus());
  expect(result.current.error).toContain("offline");
  await act(() => result.current.applyStatus());
  expect(bulkStatus.mock.calls[1]?.[2]).toBe(bulkStatus.mock.calls[0]?.[2]);
  expect(result.current.selection).toEqual([]);
});
