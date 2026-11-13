import { useCallback, useSyncExternalStore } from "react";
import type { LinkRef } from "@/features/chats/client";

/**
 * Text quoted into a Chat with Add to chat: a copy of what was selected, the
 * record it came from (linked when the message is sent) and where in it.
 * Agents still read the record itself through ticketd (spec 21.4).
 */
export type Quote = {
  id: string;
  /** "T-KQ12 · Description", "Login hardening spec". */
  source: string;
  text: string;
  record: LinkRef | null;
};

/** Where New Chat keeps its quotes, beside each Chat's own. */
export const NEW_CHAT = "new";

const store = new Map<string, Quote[]>();
const listeners = new Set<() => void>();
const NONE: Quote[] = [];
const changed = () => listeners.forEach((listener) => listener());

/** Adds a quote to a Chat's composer, shown there whenever it is next open. */
export function addQuote(chatId: string, quote: Omit<Quote, "id">) {
  store.set(chatId, [
    ...(store.get(chatId) ?? NONE),
    { ...quote, id: crypto.randomUUID() },
  ]);
  changed();
}

export function clearQuotes(chatId: string) {
  if (!store.has(chatId)) return;
  store.delete(chatId);
  changed();
}

/** A Chat's quotes, with the means to remove one. */
export function useQuotes(chatId: string) {
  const quotes = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => store.get(chatId) ?? NONE,
  );
  const remove = useCallback(
    (id: string) => {
      store.set(
        chatId,
        (store.get(chatId) ?? NONE).filter((quote) => quote.id !== id),
      );
      changed();
    },
    [chatId],
  );
  return { quotes, remove };
}

/** The message the harness receives: each quote as a Markdown block quote, then the text. */
export function quotedMessage(quotes: Quote[], text: string) {
  const blocks = quotes.map((quote) =>
    [`> From ${quote.source}:`, ...quote.text.split("\n").map((line) => `> ${line}`)]
      .join("\n")
      .replace(/> $/gm, ">"),
  );
  return [...blocks, text].filter(Boolean).join("\n\n");
}

/** The records the quotes came from, each once. */
export function quoteLinks(quotes: Quote[]): LinkRef[] {
  const links: LinkRef[] = [];
  for (const { record } of quotes)
    if (
      record &&
      !links.some((link) => link.kind === record.kind && link.id === record.id)
    )
      links.push(record);
  return links;
}
