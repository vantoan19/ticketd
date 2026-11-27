// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import {
  refreshDetailedLogging,
  setDetailedLogging,
  useDetailedLogging,
} from "@/features/settings/detailed-logging";
import { diagnosticsClient } from "@/lib/api/diagnostics";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/api/diagnostics", () => ({
  diagnosticsClient: { logLevel: vi.fn() },
}));

type Level = Awaited<ReturnType<typeof diagnosticsClient.logLevel>>;
const level = (report_started_at: string | null) =>
  ({ report_started_at }) as Level;

beforeEach(() => {
  setDetailedLogging(null);
  vi.mocked(diagnosticsClient.logLevel).mockReset();
});

test("a read that answers after a newer change does not replace it", async () => {
  let answer: (value: Level) => void = () => {};
  vi.mocked(diagnosticsClient.logLevel).mockReturnValue(
    new Promise<Level>((resolve) => {
      answer = resolve;
    }),
  );
  const state = renderHook(() => useDetailedLogging());
  const read = refreshDetailedLogging();
  // Diagnostics starts a report while the read is out.
  setDetailedLogging("2026-01-01T10:00:00Z");
  // The read was taken before the report started.
  answer(level(null));
  await read;
  expect(state.result.current).toBe("2026-01-01T10:00:00Z");
});

test("a read with no change in between is applied", async () => {
  vi.mocked(diagnosticsClient.logLevel).mockResolvedValue(
    level("2026-01-01T10:00:00Z"),
  );
  const state = renderHook(() => useDetailedLogging());
  await refreshDetailedLogging();
  expect(state.result.current).toBe("2026-01-01T10:00:00Z");
});
