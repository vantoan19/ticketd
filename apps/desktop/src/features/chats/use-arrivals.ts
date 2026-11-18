import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * What is new in a transcript. A message, step or answer rises into view once,
 * when it arrives; history (everything shown when the Chat opened, and what
 * "catching up" replays) never animates, and neither does a fold reopening.
 */
type Arrivals = {
  /** Keys that arrived after the Chat was opened. */
  fresh: ReadonlySet<string>;
  /** Keys that have already been drawn once, so a remount does not replay. */
  drawn: Set<string>;
};

const NONE: Arrivals = { fresh: new Set(), drawn: new Set() };
export const ArrivalsContext = createContext<Arrivals>(NONE);

type Known = { chatId: string; known: Set<string>; fresh: Set<string> };

/**
 * Keys the transcript has shown so far, told apart into history and arrivals.
 * `replaying` is true while the host replays history: everything is known, and
 * nothing is an arrival.
 */
export function useArrivals(
  chatId: string,
  keys: readonly string[],
  replaying: boolean,
): Arrivals {
  const [state, setState] = useState<Known>(() => ({
    chatId,
    known: new Set(keys),
    fresh: new Set(),
  }));
  const [drawn] = useState(() => new Set<string>());
  let next = state;
  if (state.chatId !== chatId) {
    next = { chatId, known: new Set(keys), fresh: new Set() };
  } else {
    const added = keys.filter((key) => !state.known.has(key));
    if (added.length > 0)
      next = {
        chatId,
        known: new Set([...state.known, ...added]),
        fresh: replaying ? state.fresh : new Set([...state.fresh, ...added]),
      };
  }
  if (next !== state) setState(next);
  return useMemo(() => ({ fresh: next.fresh, drawn }), [next.fresh, drawn]);
}

/** True once, on the mount of a key that has just arrived. */
export function useArrived(key: string): boolean {
  const { fresh, drawn } = useContext(ArrivalsContext);
  const [arrived] = useState(() => fresh.has(key) && !drawn.has(key));
  useEffect(() => {
    drawn.add(key);
  }, [drawn, key]);
  return arrived;
}

/** Chunks older than this many updates have long finished fading. */
const CHUNKS_KEPT = 40;

type Streamed = { text: string; streaming: boolean; starts: number[] };

/**
 * Where each newly streamed chunk of `text` began, for the words to fade in
 * (MarkdownDocument's `chunkStarts`). The text a Response opens with is not a
 * chunk: its message rises as a whole. Text that is replaced, not extended,
 * starts over.
 */
export function useChunkStarts(text: string, streaming: boolean) {
  const [state, setState] = useState<Streamed>({ text, streaming, starts: [] });
  let next = state;
  if (text !== state.text || streaming !== state.streaming) {
    const grew = text.length > state.text.length && text.startsWith(state.text);
    const chunked = grew && (streaming || state.streaming);
    next = {
      text,
      streaming,
      starts: !grew
        ? []
        : chunked && state.text.length > 0
          ? [...state.starts, state.text.length].slice(-CHUNKS_KEPT)
          : state.starts,
    };
  }
  if (next !== state) setState(next);
  return next.starts;
}
