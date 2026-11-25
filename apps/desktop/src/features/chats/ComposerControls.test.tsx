// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test } from "vitest";
import { HarnessPicker } from "@/features/chats/ComposerControls";

afterEach(cleanup);

const effort = (id: string, label: string, is_default = false) => ({
  id,
  label,
  is_default,
  allowed: true,
});
const efforts = [
  effort("low", "Low"),
  effort("medium", "Medium", true),
  effort("high", "High"),
];

function picker(
  models: { id: string; label: string; runs_as?: string }[],
  model: string | null,
) {
  render(
    <HarnessPicker
      harnesses={[{ id: "claude-code", name: "Claude Code", ready: true }]}
      harnessId="claude-code"
      locked
      models={models.map((option) => ({
        ...option,
        is_default: option.id === "default",
        allowed: true,
      }))}
      model={model}
      efforts={efforts}
      effort="medium"
      onModel={() => {}}
      onEffort={() => {}}
      changeable
      inputRef={createRef<HTMLTextAreaElement>()}
    />,
  );
  return screen.getByRole("button", { name: /^Claude Code/ });
}

test("with no model reported, the trigger is the mark and the effort, and never says Default", () => {
  const trigger = picker(
    [{ id: "default", label: "Default (recommended)" }],
    "default",
  );
  expect(trigger.getAttribute("aria-label")).toBe("Claude Code, effort Medium");
  expect(trigger.textContent).toBe("Medium");
  expect(trigger.querySelector(".chat-control-label")).toBeNull();
});

test("a model the harness says it runs is named before the effort", () => {
  const trigger = picker(
    [
      {
        id: "default",
        label: "Default (recommended)",
        runs_as: "Opus 5.5",
      },
    ],
    "default",
  );
  expect(trigger.getAttribute("aria-label")).toBe(
    "Claude Code, model Opus 5.5, effort Medium",
  );
  expect(trigger.textContent).toBe("Opus 5.5Medium");
});

test("a model picked by name is named, and a harness with no models names none", () => {
  expect(
    picker([{ id: "sonnet", label: "Sonnet 5" }], "sonnet").textContent,
  ).toBe("Sonnet 5Medium");
  cleanup();
  expect(picker([], null).textContent).toBe("Medium");
});

test("the effort's bars are in the trigger beside its word, for the narrow composer to swap in", () => {
  const trigger = picker([], null);
  expect(trigger.querySelector(".effort-glyph")).not.toBeNull();
  expect(trigger.querySelector(".chat-control-effort")?.textContent).toBe(
    "Medium",
  );
});

// jsdom has no cascade or layout, so the rules that order the composer's
// give-way are read as text (DESIGN.md section 15).
const css = readFileSync(join(__dirname, "chats.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** The widest composer, in px, whose container query holds a rule for `selector`. */
const hiddenBelow = (selector: string) => {
  const widths = [
    ...css.matchAll(/@container \(max-width: (\d+)px\) \{([\s\S]*?\n)\}\n/g),
  ]
    .filter((block) => (block[2] ?? "").includes(selector))
    .map((block) => Number(block[1]));
  return widths[0];
};

test("Permissions drops its label before the picker gives up the effort's word", () => {
  const permission = hiddenBelow(".chat-permission-label");
  const word = hiddenBelow(".chat-control-effort");
  expect(word).toBe(459);
  expect(permission).toBeGreaterThan(word ?? 0);
});

test("the bars replace the effort's word below 460px, and show nowhere else", () => {
  expect(css).toMatch(/\[data-control\] \.effort-glyph \{\s*display: none;/);
  const narrow = /@container \(max-width: 459px\) \{([\s\S]*?\n)\}\n/.exec(css);
  expect(narrow?.[1]).toMatch(
    /\.chat-control-effort \{\s*display: none;[\s\S]*\.effort-glyph \{\s*display: block;/,
  );
});
