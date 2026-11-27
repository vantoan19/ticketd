// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ViewRegion } from "@/components/layout/ViewRegion";
import { Step, Steps } from "@/components/ui/steps";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { FirstRunGuide } from "./FirstRunGuide";

// First run (DESIGN.md section 12): the guide arrives in a cascade of its own,
// the shell fades it out when the list holds the first ticket, and a step that
// completes draws its check. jsdom has no Web Animations, so `animate` is a spy.

vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn() },
}));
vi.mock("@/lib/api/cli", () => ({ cliClient: { check: vi.fn() } }));

const withCommand: CliStatus = {
  found: true,
  on_path: true,
  path: "/usr/local/bin/ticketd",
  version: "0.2.0",
  version_matches: true,
  workspace_path: "/w",
  workspace_matches: true,
  app_version: "0.2.0",
  app_workspace_path: "/w",
  suggested_directory: "/usr/local/bin",
  bundled: { platform: "macos", installed: true, in_the_way: null },
};
const claudeWith = (state: "installed" | "not_installed") => ({
  id: "claude",
  name: "Claude Code",
  path: "/skills",
  detected: true,
  state,
  error: null,
});

type Played = {
  element: Element;
  options: KeyframeAnimationOptions;
  onfinish: null | (() => void);
  oncancel: null | (() => void);
  finished: Promise<unknown>;
};
const played: Played[] = [];
const animate = vi.fn(function (
  this: Element,
  _keyframes: unknown,
  options: KeyframeAnimationOptions,
) {
  const animation = {
    element: this,
    options,
    onfinish: null,
    oncancel: null,
    finished: new Promise<unknown>(() => {}),
  } as Played;
  played.push(animation);
  return animation as unknown as Animation;
});

let restoreTokens: () => void;
beforeEach(() => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([]);
  vi.mocked(cliClient.check).mockResolvedValue(withCommand);
  played.length = 0;
  animate.mockClear();
  Element.prototype.animate = animate as unknown as Element["animate"];
  restoreTokens = applyTokens(rootTokens);
  // jsdom reports no client rects; whatever is mounted and not hidden is on show.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (this.closest("[hidden]") ? [] : [{}]) as unknown as DOMRectList;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreTokens();
  // @ts-expect-error jsdom has no animate; remove the spy
  delete Element.prototype.animate;
});

/** The first ticket exists: the guide gives way to the list, as App does. */
function Page({ first }: { first: boolean }) {
  return (
    <main className="content-panel">
      <ViewRegion page={first ? "first-run" : "list"}>
        {first && (
          <SettingsStateProvider active={false}>
            <FirstRunGuide disabledReason={null} onCreate={() => {}} />
          </SettingsStateProvider>
        )}
        <section className="ticket-list" hidden={first}>
          <header data-arrive="header" />
          <ul>
            <li data-arrive="row">T-1</li>
          </ul>
        </section>
      </ViewRegion>
    </main>
  );
}

// The live guide, not the shell's picture of it.
const host = () =>
  document.querySelector<HTMLElement>(
    '[data-slot="view-region"] .first-run-host',
  );

test("the guide arranges its own entrance: header, icon, title, lede, the steps card with each step, hint, one stagger step apart", () => {
  render(<Page first />);
  expect(host()?.hasAttribute("data-own-entrance")).toBe(true);
  const parts = Array.from(
    host()!.querySelectorAll<HTMLElement>("[data-enter]"),
  );
  // The card arrives with its first step, so it is never an empty box.
  expect(
    parts.map((part) => part.style.getPropertyValue("--enter-step")),
  ).toEqual(["0", "1", "2", "3", "4", "4", "5", "6", "7"]);
  expect(parts[0]?.querySelector('[data-slot="pane-header"]')).not.toBeNull();
  expect(parts[2]?.querySelector("h2")).not.toBeNull();
  expect(parts[4]?.dataset.slot).toBe("steps");
  expect(parts.slice(5, 8).map((part) => part.dataset.slot)).toEqual([
    "step",
    "step",
    "step",
  ]);
  expect(parts[8]?.textContent).toContain("to search or jump anywhere");
});

test("the guide leaves once: the shell's inert picture fades, the live guide is gone at once", () => {
  const { container, rerender } = render(<Page first />);
  rerender(<Page first={false} />);
  expect(host()).toBeNull();
  const picture = container.querySelector(".view-departing");
  expect(picture?.querySelector(".first-run-host")).not.toBeNull();
  expect(picture?.hasAttribute("inert")).toBe(true);
  expect(picture?.getAttribute("aria-hidden")).toBe("true");
  // One fade out of the picture; nothing else fades the guide.
  expect(played.filter((one) => one.options.fill === "forwards")).toHaveLength(
    1,
  );
  expect(played[0]?.element).toBe(picture);
});

test("the list then arrives as a page arrival: header, then its rows, after the picture's fade", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
  } as DOMRect);
  const { container, rerender } = render(<Page first />);
  rerender(<Page first={false} />);
  const arrivals = played.filter((one) => one.options.fill === "backwards");
  const delayOf = (kind: string) =>
    arrivals.find((one) => one.element.getAttribute("data-arrive") === kind)
      ?.options.delay;
  expect(delayOf("header")).toBe(150);
  expect(delayOf("row")).toBe(174);
  expect(
    container.querySelector(".ticket-list")?.hasAttribute("data-arriving"),
  ).toBe(true);
});

test("the shell plays nothing for a guide that is simply on show", () => {
  render(<Page first />);
  expect(animate).not.toHaveBeenCalled();
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("with %s the guide goes at once", async (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  const { container, rerender } = render(<Page first />);
  rerender(<Page first={false} />);
  await act(async () => {});
  expect(host()).toBeNull();
  expect(container.querySelector(".view-departing")).toBeNull();
  expect(animate).not.toHaveBeenCalled();
});

const drawn = () => document.querySelector('[data-slot="drawn-path"]');

test("a step that completes while on screen draws its check", () => {
  const view = (state?: "done") => (
    <Steps>
      <Step title="Install" {...(state && { state })} />
    </Steps>
  );
  const { rerender } = render(view());
  expect(drawn()).toBeNull();
  rerender(view("done"));
  expect(drawn()).not.toBeNull();
  expect(screen.getByText(/Completed/)).toBeTruthy();
});

test("a step that arrives done just shows its check", () => {
  render(
    <Steps>
      <Step title="Install" state="done" />
    </Steps>,
  );
  expect(drawn()).toBeNull();
  expect(
    document.querySelector('[data-slot="step-number"] svg'),
  ).not.toBeNull();
});

test("a step whose state is still being read shows its check, not a drawing, when it turns out done", () => {
  const view = (state: "done" | undefined, settled: boolean) => (
    <Steps>
      <Step title="Install" settled={settled} {...(state && { state })} />
    </Steps>
  );
  const { rerender } = render(view(undefined, false));
  rerender(view("done", true));
  expect(drawn()).toBeNull();
  expect(
    document.querySelector('[data-slot="step-number"] svg'),
  ).not.toBeNull();
});

test("a step read as not done draws its check when it completes later", () => {
  const view = (state: "done" | undefined, settled: boolean) => (
    <Steps>
      <Step title="Install" settled={settled} {...(state && { state })} />
    </Steps>
  );
  const { rerender } = render(view(undefined, false));
  rerender(view(undefined, true));
  rerender(view("done", true));
  expect(drawn()).not.toBeNull();
});

test("the guide shows the agents step done, not drawn, when the command and skill were there all along", async () => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([
    claudeWith("installed"),
  ]);
  render(<Page first />);
  expect(await screen.findByText(/Completed:/)).toBeTruthy();
  expect(drawn()).toBeNull();
  expect(
    document.querySelector('[data-state="done"] [data-slot="step-number"] svg'),
  ).not.toBeNull();
});

test("the guide's agents step shares Set up ticketd's state: the skill without the command does not tick it", async () => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([
    claudeWith("installed"),
  ]);
  vi.mocked(cliClient.check).mockResolvedValue({
    ...withCommand,
    found: false,
    on_path: false,
    path: null,
    version: null,
    version_matches: null,
    workspace_matches: null,
  });
  render(<Page first />);
  await act(async () => {});
  expect(screen.queryByText(/Completed:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Set up ticketd" })).toBeTruthy();
});
