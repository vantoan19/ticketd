// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { client } from "@/lib/api/client";
import { BridgeFailure } from "@/lib/api/bridge-failure";
import { useBulkEdit } from "./useBulkEdit";

afterEach(() => vi.restoreAllMocks());

test("a retry of the same bulk change reuses its request ID", async () => {
  const bulkStatus = vi
    .spyOn(client, "bulkStatus")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined as never);
  const { result } = renderHook(() => useBulkEdit(async () => {}));
  act(() => result.current.toggle("T-KQ1"));
  await act(() => result.current.applyStatus("Done", "Updated"));
  expect(result.current.failure?.description.details).toContain("offline");
  expect(result.current.selection).toEqual(["T-KQ1"]);
  await act(async () => {
    await result.current.retry();
  });
  expect(bulkStatus.mock.calls[1]?.[2]).toBe(bulkStatus.mock.calls[0]?.[2]);
  expect(result.current.selection).toEqual([]);
  expect(result.current.notice).toBe("Updated");
  expect(result.current.failure).toBeNull();
});

test("a rejected batch names the ticket that prevented it and keeps the selection", async () => {
  vi.spyOn(client, "bulkChange").mockRejectedValue(
    new BridgeFailure("batch_operation", "invalid batch: ticket is trashed", 1),
  );
  const { result } = renderHook(() => useBulkEdit(async () => {}));
  act(() => result.current.selectAll(["T-KQ1", "T-KQ2", "T-KQ3"]));
  await act(() => result.current.applyOrganization({ plan_id: "e1" }, "ok"));
  expect(result.current.failure).toMatchObject({
    reference: "T-KQ2",
    // The core refused the change itself, so sending it again cannot succeed.
    retryable: false,
    description: {
      title: "Couldn't change T-KQ2",
      sentence:
        "The batch was rejected. Nothing changed. Open Details to review the reason.",
      action: null,
    },
  });
  expect(result.current.selection).toEqual(["T-KQ1", "T-KQ2", "T-KQ3"]);
  act(() => result.current.toggle("T-KQ3"));
  expect(result.current.failure).toBeNull();
});

test("changing the selection after a failure uses a new request ID", async () => {
  const bulkChange = vi
    .spyOn(client, "bulkChange")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined as never);
  const { result } = renderHook(() => useBulkEdit(async () => {}));
  act(() => result.current.selectAll(["T-KQ1", "T-KQ2"]));
  await act(() => result.current.applyOrganization({ plan_id: null }, "ok"));
  act(() => result.current.toggle("T-KQ2"));
  await act(() => result.current.applyOrganization({ plan_id: null }, "ok"));
  expect(bulkChange.mock.calls[1]?.[2]).not.toBe(bulkChange.mock.calls[0]?.[2]);
});
