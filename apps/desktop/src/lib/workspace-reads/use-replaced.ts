import { useReads } from "./reads-context";

/**
 * Reports that the whole Workspace was replaced (a restore, or a download that
 * replaces it), so nothing cached describes it any more. Every cached value is
 * dropped, visible reads read again, hidden ones read when shown, and the next
 * poll counts as a change. It never rejects.
 */
export function useReplaced(): () => Promise<void> {
  return useReads("useReplaced").replaced;
}
