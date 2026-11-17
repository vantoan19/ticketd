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
  // A record that is known is read once more for each followed mention,
  // whatever it holds (a copy as current as the last change, a stale one, or
  // one with a failure kept from before): `retry` resolves only once a read
  // made after the call has answered, with a body or a failure. A record never
  // read waits for the page's first read of it, which is made after the follow.
  const forced = useRef<number | null>(null);
  useEffect(() => {
    if (!judging || key === undefined || selected === null) return;
    if (forced.current === key) return;
    if (known) {
      forced.current = key;
      void retry().then(() => {
        if (forced.current === key) onReady(selected);
      });
    } else if (current || failed) onReady(selected);
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
