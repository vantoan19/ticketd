import { useEffect, useRef } from "react";
import { useTicket } from "./open-ticket";
import type { FollowedMention } from "./useTicketWorkspace";

/**
 * Judges a followed mention against the selected ticket's stored text. It is
 * `ready` once the record has been read after the mention was followed (the
 * cached copy may predate an edit the poll has not reported yet), or when that
 * read has failed, so the page reveals against what is cached rather than
 * never. It ends when the ticket is trashed or restored, which swaps the
 * ticket's view.
 */
export function useMentionReadiness({
  selected,
  mention,
  onReady,
  onEnd,
}: {
  selected: string | null;
  mention: FollowedMention | null;
  onReady: (reference: string) => void;
  onEnd: () => void;
}) {
  const record = useTicket(selected);
  const { retry } = record;
  const current = record.current;
  const known = record.value !== undefined;
  const failed = record.failure !== null;
  const key = mention?.key;
  const judging =
    mention !== null && !mention.ready && selected !== null
      ? mention.reference === selected
      : false;
  // How each followed mention is judged. A cached copy that is as current as
  // the last change is read once more; one a change made stale, or one never
  // read, is read anyway when the page is shown, so it only waits for that.
  const route = useRef<{ key: number; reread: boolean } | null>(null);
  useEffect(() => {
    if (!judging || key === undefined || selected === null) return;
    if (route.current?.key !== key) {
      route.current = { key, reread: known && current && !failed };
      if (route.current.reread) {
        void retry().then(() => {
          if (route.current?.key === key) onReady(selected);
        });
        return;
      }
    }
    if (!route.current.reread && (current || failed)) onReady(selected);
  }, [judging, key, selected, known, current, failed, retry, onReady]);

  const trashed = record.value?.trashed;
  const seen = useRef<{ reference: string; trashed: boolean } | null>(null);
  useEffect(() => {
    if (!selected || trashed === undefined) return;
    const before = seen.current;
    seen.current = { reference: selected, trashed };
    if (before?.reference === selected && before.trashed !== trashed) onEnd();
  }, [selected, trashed, onEnd]);
}
