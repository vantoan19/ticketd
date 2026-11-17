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
  // Decided once per mention, when it is first judged (the answer to the
  // page's first read must not turn a never-read record into a known one that
  // is then read again). A current copy, or any kept failure, is read once
  // more: `retry` resolves only once a read made after the call has answered,
  // with a body or a failure. A record never read, or a stale one the page is
  // already re-reading, waits for that read (`current`, or a failure).
  const decided = useRef<{ key: number; force: boolean } | null>(null);
  useEffect(() => {
    if (!judging || key === undefined || selected === null) return;
    if (decided.current?.key !== key) {
      const force = known && (current || failed);
      decided.current = { key, force };
      if (force) {
        void retry().then(() => {
          if (decided.current?.key === key) onReady(selected);
        });
      }
    }
    if (!decided.current.force && (current || failed)) onReady(selected);
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
