import type { LinkRef, LinkedRecord } from "@/features/chats/client";

/**
 * The composer's mentions and commands over plain text. A token is a range
 * of the message that was inserted from a menu: a record (linked when the
 * message is sent), a path, a skill or a command. Typing inside a token makes it plain
 * text again; Backspace and Delete remove it whole; the arrows step over it.
 */
export type Token =
  | {
      kind: "record";
      start: number;
      end: number;
      text: string;
      record: LinkedRecord;
    }
  | {
      kind: "path" | "command" | "skill";
      start: number;
      end: number;
      text: string;
    };

/** What a menu pick inserts: a token without its place yet. */
export type Insert =
  | { kind: "record"; text: string; record: LinkedRecord }
  | { kind: "path" | "command" | "skill"; text: string };

export type Trigger = {
  char: "#" | "@" | "/" | "$";
  start: number;
  query: string;
};

/**
 * The menu the caret is in, if any. `#`, `@` and `$` open at the start of a word,
 * never inside one or a URL; `/` only at the very start of the message. A space
 * ends the query, so `# ` (a heading) never opens the menu.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
  const char = text.charAt(start);
  if (char !== "#" && char !== "@" && char !== "/" && char !== "$") return null;
  if (char === "/" && start !== 0) return null;
  const query = text.slice(start + 1, caret);
  if (query.includes(char)) return null;
  return { char, start, query };
}

const place = (token: Token, start: number): Token => ({
  ...token,
  start,
  end: start + token.text.length,
});

/** Replaces the trigger and its query with the pick, plus a space when none follows. */
export function insertToken(
  text: string,
  tokens: Token[],
  trigger: Trigger,
  caret: number,
  pick: Insert,
) {
  const after = text.slice(caret);
  const spaced = /^\s/.test(after) ? pick.text : `${pick.text} `;
  const next = text.slice(0, trigger.start) + spaced + after;
  const shift = spaced.length - (caret - trigger.start);
  const token = place({ ...pick, start: 0, end: 0 } as Token, trigger.start);
  const moved = tokens
    .filter((item) => item.end <= trigger.start || item.start >= caret)
    .map((item) =>
      item.start >= caret ? place(item, item.start + shift) : item,
    );
  return {
    text: next,
    caret: trigger.start + pick.text.length + 1,
    tokens: [...moved, token].sort((a, b) => a.start - b.start),
  };
}

/**
 * Carries tokens across an edit from `prev` to `next`: those before the change
 * stay, those after it move, and one the change touched is no longer a token.
 * A token in `removed` comes back when the edit puts its text back where it
 * was, as undo does after Backspace removed it.
 */
export function reconcile(
  prev: string,
  next: string,
  tokens: Token[],
  removed: Token[] = [],
): Token[] {
  let head = 0;
  const shortest = Math.min(prev.length, next.length);
  while (head < shortest && prev[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < shortest - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail += 1;
  const changedEnd = prev.length - tail;
  const shift = next.length - prev.length;
  const kept = tokens
    // Text typed right after a token's last character, or before its first, is outside it.
    .filter((token) => token.end <= head || token.start >= changedEnd)
    .map((token) =>
      token.end <= head ? token : place(token, token.start + shift),
    );
  const back = removed.filter(
    (token) =>
      next.slice(token.start, token.end) === token.text &&
      prev.slice(token.start, token.end) !== token.text &&
      !kept.some((item) => item.start < token.end && token.start < item.end),
  );
  return [...kept, ...back].sort((a, b) => a.start - b.start);
}

/** Backspace at a token's end, or Delete at its start, removes the whole token. */
export function removeToken(
  text: string,
  tokens: Token[],
  caret: number,
  direction: "back" | "forward",
) {
  const token = tokens.find((item) =>
    direction === "back" ? item.end === caret : item.start === caret,
  );
  if (!token) return null;
  const length = token.end - token.start;
  return {
    text: text.slice(0, token.start) + text.slice(token.end),
    caret: token.start,
    tokens: tokens
      .filter((item) => item !== token)
      .map((item) =>
        item.start >= token.end ? place(item, item.start - length) : item,
      ),
    removed: token,
  };
}

/** Where ← or → lands when the caret is at a token's edge; null to move normally. */
export function stepOver(
  tokens: Token[],
  caret: number,
  direction: "left" | "right",
): number | null {
  const token = tokens.find((item) =>
    direction === "left" ? item.end === caret : item.start === caret,
  );
  if (!token) return null;
  return direction === "left" ? token.start : token.end;
}

/** The records the message links when it is sent, each once. */
export function linksOf(tokens: Token[]): LinkRef[] {
  const links: LinkRef[] = [];
  for (const token of tokens)
    if (
      token.kind === "record" &&
      !links.some(
        (link) =>
          link.kind === token.record.kind && link.id === token.record.id,
      )
    )
      links.push({ kind: token.record.kind, id: token.record.id });
  return links;
}

/** The text a record is mentioned by: a ticket's reference, else its name. */
export const mentionText = (record: LinkedRecord) =>
  record.kind === "ticket" ? record.reference : record.title;

/** A sent message's text, with each mention of a linked record marked. */
export type SentPart = { text: string; record?: LinkedRecord };

const QUOTE_SOURCE = /^> From (.+):$/;

/** A record's name stands alone: not part of a longer word or reference. */
const standsAlone = (text: string, start: number, end: number) =>
  !/[\p{L}\p{N}-]/u.test(text.charAt(start - 1)) &&
  !/[\p{L}\p{N}-]/u.test(text.charAt(end));

/**
 * A sent message as it reads: the quotes it starts with (as `quotedMessage`
 * wrote them), then its text with the linked records it mentions marked, so
 * they stay links once sent.
 */
export function sentParts(text: string, linked: LinkedRecord[]) {
  const blocks = text.split("\n\n");
  const quotes: { source: string; text: string }[] = [];
  while (blocks.length > 0) {
    const lines = (blocks[0] ?? "").split("\n");
    const source = QUOTE_SOURCE.exec(lines[0] ?? "")?.[1];
    if (!source || !lines.every((line) => line.startsWith(">"))) break;
    quotes.push({
      source,
      text: lines
        .slice(1)
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n"),
    });
    blocks.shift();
  }
  const body = blocks.join("\n\n");
  // Longest names first, so a longer name wins where one starts another.
  const names = linked
    .map((record) => ({ name: mentionText(record), record }))
    .filter(({ name }) => name.trim() !== "")
    .sort((a, b) => b.name.length - a.name.length);
  const parts: SentPart[] = [];
  let plain = "";
  for (let at = 0; at < body.length;) {
    const found = names.find(
      ({ name }) =>
        body.startsWith(name, at) && standsAlone(body, at, at + name.length),
    );
    if (!found) {
      plain += body.charAt(at);
      at += 1;
      continue;
    }
    if (plain) parts.push({ text: plain });
    plain = "";
    parts.push({ text: found.name, record: found.record });
    at += found.name.length;
  }
  if (plain) parts.push({ text: plain });
  return { quotes, parts };
}
