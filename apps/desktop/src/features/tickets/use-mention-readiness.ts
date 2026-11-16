import { useEffect, useRef } from "react";
import { useTicket } from "./open-ticket";
import type { FollowedMention } from "./useTicketWorkspace";

/**
 * Judges a followed mention against the selected ticket's stored text: it is
 * `ready` once the record is current after the selection (or its read has
 * failed, so the page reveals against what is cached rather than never). It
 * ends when the ticket is trashed or restored, which swaps the ticket's view.
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
  const settled = record.current || record.failure !== null;
  const waiting = mention !== null && !mention.ready;
  const mentioned = mention?.reference;
  useEffect(() => {
    if (waiting && selected && mentioned === selected && settled)
      onReady(selected);
  }, [waiting, mentioned, selected, settled, onReady]);

  const trashed = record.value?.trashed;
  const seen = useRef<{ reference: string; trashed: boolean } | null>(null);
  useEffect(() => {
    if (!selected || trashed === undefined) return;
    const before = seen.current;
    seen.current = { reference: selected, trashed };
    if (before?.reference === selected && before.trashed !== trashed) onEnd();
  }, [selected, trashed, onEnd]);
}
