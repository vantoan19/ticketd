import { expect, test } from "vitest";
import type { TranscriptItem } from "@/features/chats/client";
import {
  filesSummary,
  shortenedPath,
  reasoningWords,
  tokens,
} from "@/features/chats/reports";

const at = "";
const reasoning = (
  over: Partial<Extract<TranscriptItem, { kind: "reasoning" }>>,
) =>
  ({
    id: "rs",
    at,
    kind: "reasoning",
    turn_id: "t",
    state: "done",
    ...over,
  }) as Extract<TranscriptItem, { kind: "reasoning" }>;

test("reasoning never says 0s and says nothing it was not told", () => {
  expect(reasoningWords(reasoning({ started_at: 0, ended_at: 400 })).text).toBe(
    "Thought",
  );
  expect(reasoningWords(reasoning({})).text).toBe("Thought");
  expect(
    reasoningWords(reasoning({ started_at: 0, ended_at: 133_000 })).label,
  ).toBe("Show reasoning, thought for 2 minutes 13 seconds");
  expect(reasoningWords(reasoning({ state: "running" })).text).toBe(
    "Thinking…",
  );
  expect(
    reasoningWords(reasoning({ state: "running", heading: "Reading" })).text,
  ).toBe("Thinking · Reading");
  expect(reasoningWords(reasoning({ state: "unknown" })).outcome).toBe(
    "Not confirmed",
  );
});

test("totals leave out unconfirmed edits and files without counts", () => {
  const file = (over: object) => ({
    path: "a",
    open_path: "/a",
    kind: "modified" as const,
    confirmed: true,
    ...over,
  });
  expect(
    filesSummary([
      file({ added_lines: 2, removed_lines: 1 }),
      file({}),
      file({ added_lines: 9, removed_lines: 9, confirmed: false }),
    ]),
  ).toEqual({
    text: "3 files changed",
    counts: "+2 −1",
    unconfirmed: "1 not confirmed",
  });
  expect(filesSummary([file({})])).toEqual({
    text: "1 file changed",
    counts: null,
    unconfirmed: null,
  });
});

test("token counts and long paths read short", () => {
  expect(tokens(124_400)).toBe("124k");
  expect(tokens(1_000_000)).toBe("1M");
  expect(tokens(999)).toBe("999");
  expect(
    shortenedPath("src/a/very/deep/folder/tree/that/goes/on/and/on/limiter.ts"),
  ).toBe("src/a/very/deep/folder/tree/that/goes…/limiter.ts");
});
