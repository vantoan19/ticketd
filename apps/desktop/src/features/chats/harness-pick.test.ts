// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import {
  NO_PICK,
  offeredPick,
  rememberPick,
  rememberedPick,
  withModel,
} from "@/features/chats/harness-pick";
import { HARNESS_OPTIONS } from "@/features/chats/mock-client";

const claude = HARNESS_OPTIONS[0];

beforeEach(() => localStorage.clear());

test("a pick is remembered per harness for the next New Chat", () => {
  rememberPick("claude-code", {
    model: "sonnet",
    effort: "high",
    permission: "acceptEdits",
  });

  expect(rememberedPick("claude-code")).toEqual({
    model: "sonnet",
    effort: "high",
    permission: "acceptEdits",
  });
  expect(rememberedPick("codex")).toEqual(NO_PICK);
});

test("a remembered pick the harness no longer offers falls back to its own setting", () => {
  expect(
    offeredPick(claude, {
      model: "opus-4",
      effort: "max",
      permission: "dontAsk",
    }),
  ).toEqual({ model: null, effort: "max", permission: null });
  // Max is the default model's; nothing is offered when the harness listed nothing.
  expect(offeredPick(undefined, { ...NO_PICK, model: "sonnet" })).toEqual(
    NO_PICK,
  );
});

test("choosing a model keeps the effort only when that model takes it", () => {
  const high = { model: "default", effort: "high", permission: null };
  expect(withModel(claude, high, "sonnet").effort).toBe("high");
  expect(withModel(claude, high, "haiku").effort).toBeNull();
});
