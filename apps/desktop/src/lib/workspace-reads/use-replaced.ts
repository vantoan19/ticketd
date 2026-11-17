import { useReads } from "./reads-context";

/**
 * Reports that the whole Workspace was replaced (a restore, or a download that
 * replaces it), so nothing cached describes it any more. It reads the change
 * token first, so the poll after it starts no second wave. Every cached value,
 * remembered "Show more" page and failure is dropped; visible reads read again
 * and hidden ones read when shown. It never rejects.
 */
export function useReplaced(): () => Promise<void> {
  return useReads("useReplaced").replaced;
}
