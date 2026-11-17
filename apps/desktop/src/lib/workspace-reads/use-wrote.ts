import type { Returned } from "./catalog";
import { useReads } from "./reads-context";

/**
 * The write report, called once at each write site after the write succeeded.
 * In this order it:
 *
 * 1. drops the late answers of reads sent before the write, which may not
 *    include it, and shows what the write returned or set at once: returned
 *    Tickets, and `fills` for any other declared read (`fillRead`, `updateRead`
 *    and `updatePagedRead`; sections export builders for their own writes). A
 *    filled value stays through a failed re-read, and the next good read
 *    replaces it, so no view keeps a copy of what it wrote;
 * 2. reads the change token, so the next poll does not start a second wave;
 * 3. makes every visible read stale, reusing reads sent after the report;
 * 4. moves the shared change version for views not yet on this module.
 *
 * It resolves when the visible reads settle and never rejects.
 */
export function useWrote(): (returned?: Returned) => Promise<void> {
  return useReads("useWrote").wrote;
}
