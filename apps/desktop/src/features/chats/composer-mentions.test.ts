import { describe, expect, it } from "vitest";
import {
  insertToken,
  linksOf,
  reconcile,
  removeToken,
  stepOver,
  triggerAt,
  type Token,
} from "@/features/chats/composer-mentions";

const ticket = {
  kind: "ticket" as const,
  id: "t1",
  reference: "T-KQ12",
  title: "Login",
  status: "Todo",
};

describe("triggerAt", () => {
  it("opens # and @ at a word start, and / only at the start of the message", () => {
    expect(triggerAt("see #log", 8)).toEqual({
      char: "#",
      start: 4,
      query: "log",
    });
    expect(triggerAt("@src/a", 6)).toEqual({ char: "@", start: 0, query: "src/a" });
    expect(triggerAt("/rev", 4)).toEqual({ char: "/", start: 0, query: "rev" });
    expect(triggerAt("run /rev", 8)).toBeNull();
  });

  it("stays closed inside a word, a URL or a heading", () => {
    expect(triggerAt("issue#12", 8)).toBeNull();
    expect(triggerAt("http://x.dev/#top", 17)).toBeNull();
    expect(triggerAt("# Title", 7)).toBeNull();
    expect(triggerAt("##", 2)).toBeNull();
  });
});

describe("tokens", () => {
  it("inserts a token and a space, replacing what was typed after the trigger", () => {
    const inserted = insertToken(
      "see #log now",
      [],
      { char: "#", start: 4, query: "log" },
      8,
      { kind: "record", text: "T-KQ12", record: ticket },
    );
    // The space already there is the one after the token.
    expect(inserted.text).toBe("see T-KQ12 now");
    expect(inserted.caret).toBe(11);
    expect(
      insertToken("#lo", [], { char: "#", start: 0, query: "lo" }, 3, {
        kind: "record",
        text: "T-KQ12",
        record: ticket,
      }).text,
    ).toBe("T-KQ12 ");
    expect(inserted.tokens).toEqual([
      { kind: "record", start: 4, end: 10, text: "T-KQ12", record: ticket },
    ]);
    expect(linksOf(inserted.tokens)).toEqual([{ kind: "ticket", id: "t1" }]);
  });

  const token: Token = {
    kind: "record",
    start: 4,
    end: 10,
    text: "T-KQ12",
    record: ticket,
  };

  it("moves with edits before it and stops being a link once edited inside", () => {
    expect(reconcile("see T-KQ12 x", "I see T-KQ12 x", [token])).toEqual([
      { ...token, start: 6, end: 12 },
    ]);
    expect(reconcile("see T-KQ12 x", "see T-KQ1 x", [token])).toEqual([]);
    expect(reconcile("see T-KQ12 x", "see T-KQ12 xy", [token])).toEqual([token]);
  });

  it("is removed whole by Backspace or Delete and stepped over by the arrows", () => {
    expect(removeToken("see T-KQ12 x", [token], 10, "back")).toEqual({
      text: "see  x",
      caret: 4,
      tokens: [],
      removed: token,
    });
    expect(removeToken("see T-KQ12 x", [token], 4, "forward")?.text).toBe(
      "see  x",
    );
    expect(removeToken("see T-KQ12 x", [token], 11, "back")).toBeNull();
    expect(stepOver([token], 10, "left")).toBe(4);
    expect(stepOver([token], 4, "right")).toBe(10);
    expect(stepOver([token], 2, "right")).toBeNull();
  });

  it("comes back when undo restores its text where it was", () => {
    expect(reconcile("see  x", "see T-KQ12 x", [], [token])).toEqual([token]);
  });
});
