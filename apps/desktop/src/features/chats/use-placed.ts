import { useState } from "react";
import type { ChatSummary } from "@/features/chats/client";

export type Placed = { chat: ChatSummary; needs: boolean };

/**
 * The list in order: the Chats that need you first. While the pointer is over
 * the list its order and groups are held, so nothing moves under it; the Chats
 * still update in place, and any move happens once the pointer leaves.
 */
export function usePlaced(
  chats: ChatSummary[] | undefined,
  held: boolean,
): Placed[] {
  const needs = (chat: ChatSummary) => chat.status.rank === "approval";
  const current = (chats ?? [])
    .slice()
    .sort((a, b) => Number(needs(b)) - Number(needs(a)))
    .map((chat) => ({ id: chat.id, needs: needs(chat) }));
  const [frozen, setFrozen] = useState(current);
  const same =
    frozen.length === current.length &&
    frozen.every(
      (one, index) =>
        one.id === current[index]?.id && one.needs === current[index].needs,
    );
  if (!held && !same) setFrozen(current);
  const shown = held ? frozen : current;
  const byId = new Map((chats ?? []).map((chat) => [chat.id, chat]));
  const placed = shown.flatMap(({ id, needs }) => {
    const chat = byId.get(id);
    return chat ? [{ chat, needs }] : [];
  });
  // A Chat that appeared while the list was held goes on top of its group.
  const unplaced = current.flatMap(({ id, needs }) => {
    const chat = byId.get(id);
    return chat && !shown.some((one) => one.id === id) ? [{ chat, needs }] : [];
  });
  return [
    ...unplaced.filter((one) => one.needs),
    ...placed,
    ...unplaced.filter((one) => !one.needs),
  ];
}
