import { expect, test } from "vitest";
import { effortBars, settingLine } from "@/features/chats/composer-settings";
import { chatState } from "@/features/chats/mock-client";
import { contextLabel } from "@/features/chats/model";

const efforts = ["low", "medium", "high", "max"].map((id) => ({ id }));

test("effort bars rise with the harness's order and Max fills them", () => {
  expect(effortBars(efforts, "low")).toEqual({ count: 3, filled: 1 });
  expect(effortBars(efforts, "high")).toEqual({ count: 3, filled: 3 });
  expect(effortBars(efforts, "max")).toEqual({ count: 3, filled: 3 });
  // In the menu Max has an empty slot, so the words line up.
  expect(effortBars(efforts, "max", true)).toBeNull();
  // Five levels still draw at most four bars.
  const codex = ["minimal", "low", "medium", "high", "xhigh"].map((id) => ({
    id,
  }));
  expect(effortBars(codex, "minimal")).toEqual({ count: 4, filled: 1 });
  expect(effortBars(codex, "xhigh")).toEqual({ count: 4, filled: 4 });
});

test("the context button names folder, branch, Project and sharing", () => {
  const chat = chatState({
    id: "c1",
    title: "Limiter",
    folder: {
      name: "web-app",
      branch: { kind: "branch", name: "rate-limit-logins" },
      project: { id: "p1", title: "Web App" },
      shared_with: ["Alert on-call"],
    },
  });
  expect(contextLabel(chat)).toBe(
    "Folder web-app, branch rate-limit-logins, Project Web App, used by 1 other Chat",
  );
  const managed = chatState({
    id: "c2",
    title: "Tidy",
    folder: { name: "8b65", managed: true },
  });
  expect(contextLabel(managed)).toBe("Folder ticketd folder");
  const missing = chatState({
    id: "c3",
    title: "Reset",
    folder: {
      name: "reset-email",
      missing: true,
      branch: { kind: "detached", name: "3f9c2a1" },
    },
  });
  expect(contextLabel(missing)).toBe(
    "Folder reset-email, missing, detached at 3f9c2a1",
  );
});

test("a refused or unconfirmed change is one line; an applied one says nothing", () => {
  const settings = {
    model: {
      current: "opus",
      options: [
        { id: "opus", label: "Opus 5.5", is_default: true, allowed: true },
        { id: "sonnet", label: "Sonnet 5", is_default: false, allowed: true },
      ],
      changeable: true,
      applies_from: "next_turn" as const,
    },
  };
  const chat = chatState({
    id: "c1",
    title: "Limiter",
    harness: { id: "claude-code", name: "Claude Code" },
    settings,
  });
  const asked = (state: "refused" | "unconfirmed" | "applied") => ({
    setting: "model" as const,
    outcome: {
      value: "sonnet",
      state,
      reason: "it isn't available on your plan.",
    },
  });
  expect(settingLine(chat, asked("refused"))).toBe(
    "Claude Code didn't switch to Sonnet 5: it isn't available on your plan.",
  );
  expect(settingLine(chat, asked("unconfirmed"))).toBe(
    "Sonnet 5 not confirmed. Claude Code may still be using Opus 5.5.",
  );
  expect(settingLine(chat, asked("applied"))).toBeNull();
  // A held change that the host later refused reads as refused.
  const later = chatState({
    id: "c1",
    title: "Limiter",
    harness: { id: "claude-code", name: "Claude Code" },
    settings: {
      model: {
        ...settings.model,
        change: { value: "sonnet", state: "refused", reason: "busy" },
      },
    },
  });
  expect(
    settingLine(later, {
      setting: "model",
      outcome: { value: "sonnet", state: "held" },
    }),
  ).toBe("Claude Code didn't switch to Sonnet 5: busy.");
  expect(settingLine(chat, null)).toBeNull();
});
