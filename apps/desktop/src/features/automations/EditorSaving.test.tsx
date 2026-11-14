// @vitest-environment jsdom
import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AutomationEditor } from "@/features/automations/AutomationEditor";
import type {
  Automation,
  AutomationDefinition,
} from "@/features/automations/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_projects") return [];
    throw new Error(`unexpected command ${command}`);
  });
});
afterEach(cleanup);

const TRIAGE: Automation = {
  id: "automation-1",
  name: "Triage",
  trigger: { kind: "tag_added", tag: "ready-for-triage" },
  conditions: [],
  steps: [
    {
      id: "tell",
      kind: "notify",
      text: "Tagged",
      opens: "ticket",
      on_failure: null,
    },
  ],
  enabled: true,
  arrived_off: false,
  problems: [],
  has_ticket: true,
};

/** Each save the editor sent: the trigger's tag, and whether it was still typing. */
let sent: [string, boolean][];
/** While set, the fake core refuses every save with it. */
let refusal: string | null;
/** Changes the Automation under the editor, as a refresh after Workspace sync does. */
let arrive: (definition: Partial<AutomationDefinition>) => void;

const tagOf = (definition: Partial<AutomationDefinition>) =>
  definition.trigger?.kind === "tag_added" ? definition.trigger.tag : "";

/**
 * The editor over a fake core with the one rule these tests are about: a tag
 * trigger needs a tag; an Automation that is on is switched off by an edit
 * that leaves it without one, unless the edit is still being typed, which is
 * then not stored.
 */
function Page() {
  const [automation, setAutomation] = useState(TRIAGE);
  useEffect(() => {
    arrive = (definition) =>
      setAutomation((current) => ({ ...current, ...definition }));
  }, []);
  return (
    <AutomationEditor
      automation={automation}
      agents={[]}
      expanded={false}
      single={false}
      onExpand={() => {}}
      onReturn={() => {}}
      onClose={() => {}}
      onChange={async (definition, typing) => {
        sent.push([tagOf(definition), typing]);
        if (refusal) throw new Error(refusal);
        const unfinished = tagOf(definition) === "";
        if (typing && automation.enabled && unfinished) return automation;
        const stored = {
          ...automation,
          ...definition,
          enabled: automation.enabled && !unfinished,
          problems: unfinished
            ? [{ step_id: "trigger", message: "Needs a tag" }]
            : [],
        };
        setAutomation(stored);
        return stored;
      }}
      onSetEnabled={(enabled) =>
        setAutomation((current) => ({ ...current, enabled }))
      }
      onStopAndTurnOff={() => {}}
      onDelete={() => {}}
      onDuplicate={() => {}}
      onCreateAgent={async () => undefined}
      onSaveAgent={() => {}}
      onDeleteAgent={() => {}}
      onFail={() => {}}
      onRead={() => {}}
      openRun={null}
      onOpenRun={() => {}}
    />
  );
}

/** Opens the editor on the trigger's panel and answers with its tag field. */
const open = async () => {
  sent = [];
  refusal = null;
  render(<Page />);
  const steps = await screen.findByRole("application", { name: "Steps" });
  fireEvent.click(within(steps).getByRole("button", { name: /^When/ }));
  const panel = await screen.findByRole("complementary");
  return within(panel).getByRole("textbox", {
    name: "Tag",
  }) as HTMLInputElement;
};
/** Types in a field that has focus, as a person does. */
const type = (field: HTMLInputElement, value: string) => {
  field.focus();
  fireEvent.change(field, { target: { value } });
};
const onSwitch = () =>
  screen.getByRole("switch", { name: "On for this desktop" });

test("a tag emptied while retyping it does not switch the Automation off; leaving the field empty does, and says so", async () => {
  const tag = await open();

  // Emptied on the way to another tag, then typed again: still on throughout.
  type(tag, "");
  type(tag, "bug");
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent).toEqual([
    ["", true],
    ["bug", true],
  ]);
  expect(onSwitch().getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText("Switched off")).toBeNull();
  // Leaving the field makes it the edit: saved once more, for good.
  fireEvent.blur(tag);
  await waitFor(() => expect(sent.at(-1)).toEqual(["bug", false]));
  expect(onSwitch().getAttribute("aria-checked")).toBe("true");

  // Emptied and left: it cannot run, so it goes off, with the reason on screen.
  type(tag, "");
  fireEvent.blur(tag);

  const notice = (await screen.findByText("Switched off")).closest(
    "[data-slot=alert]",
  ) as HTMLElement;
  expect(notice.textContent).toContain("Needs a tag");
  expect(onSwitch().getAttribute("aria-checked")).toBe("false");
  const back = within(notice).getByRole("button", { name: "Switch back on" });
  expect((back as HTMLButtonElement).disabled).toBe(true);

  // Finished again, it is offered back, and the notice goes once it is on.
  type(tag, "bug");
  fireEvent.blur(tag);
  await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(back);
  await waitFor(() => expect(screen.queryByText("Switched off")).toBeNull());
  expect(onSwitch().getAttribute("aria-checked")).toBe("true");
});

test("a save that fails says so in the editor, keeps the edit, and Retry saves it", async () => {
  const tag = await open();
  refusal = "the workspace is busy";

  type(tag, "bug");
  fireEvent.blur(tag);

  const notice = (await screen.findByText("Not saved")).closest(
    "[data-slot=alert]",
  ) as HTMLElement;
  expect(notice.getAttribute("role")).toBe("alert");
  expect(notice.textContent).toContain("the workspace is busy");
  expect(tag.value).toBe("bug");

  refusal = null;
  const before = sent.length;
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(screen.queryByText("Not saved")).toBeNull());
  expect(sent.slice(before)).toEqual([["bug", false]]);
});

test("a definition changed elsewhere is taken when nothing here is unsaved", async () => {
  const tag = await open();

  act(() => arrive({ trigger: { kind: "tag_added", tag: "from-the-laptop" } }));

  await waitFor(() => expect(tag.value).toBe("from-the-laptop"));
  expect(screen.queryByText("Changed somewhere else")).toBeNull();
  // The next edit builds on it instead of putting the old definition back.
  type(tag, "from-the-laptop-2");
  fireEvent.blur(tag);
  await waitFor(() =>
    expect(sent.at(-1)).toEqual(["from-the-laptop-2", false]),
  );
});

test("a definition changed elsewhere under an unsaved edit asks which to keep", async () => {
  const tag = await open();
  // Held back by the core: typed, and not stored.
  type(tag, "");
  await waitFor(() => expect(sent).toEqual([["", true]]));

  act(() => arrive({ name: "Triage bugs" }));

  const notice = (await screen.findByText("Changed somewhere else")).closest(
    "[data-slot=alert]",
  ) as HTMLElement;
  // Nothing is overwritten until the person says.
  expect(tag.value).toBe("");
  expect(sent).toHaveLength(1);

  fireEvent.click(
    within(notice).getByRole("button", { name: "Use that version" }),
  );

  await waitFor(() => expect(tag.value).toBe("ready-for-triage"));
  expect(screen.getByRole("heading", { name: "Triage bugs" })).toBeTruthy();
  expect(screen.queryByText("Changed somewhere else")).toBeNull();
  expect(sent).toHaveLength(1);
});

test("the header says what is left without calling the trigger a step", async () => {
  await open();
  const left = (problems: Automation["problems"]) => {
    act(() => arrive({ ...TRIAGE, problems } as Partial<AutomationDefinition>));
    return document.querySelector(".auto-left")?.textContent;
  };

  // Only a trigger so far: the switch is off limits, and the header says why.
  expect(left([{ step_id: null, message: "Add a step" }])).toBe("Add a step");
  expect(
    left([
      { step_id: "trigger", message: "Needs a tag" },
      { step_id: "tell", message: "Needs a message" },
    ]),
  ).toBe("Trigger unfinished · 1 step left");
  expect(
    left([
      { step_id: "a", message: "Needs a folder" },
      { step_id: "b", message: "Needs a folder" },
    ]),
  ).toBe("2 steps left");
});

test("the Switched off notice does not come back when the person later switches the Automation off", async () => {
  const tag = await open();
  type(tag, "");
  fireEvent.blur(tag);
  const notice = await screen.findByText("Switched off");
  type(tag, "bug");
  fireEvent.blur(tag);
  const back = within(
    notice.closest("[data-slot=alert]") as HTMLElement,
  ).getByRole("button", { name: "Switch back on" }) as HTMLButtonElement;
  await waitFor(() => expect(back.disabled).toBe(false));
  fireEvent.click(back);
  await waitFor(() => expect(screen.queryByText("Switched off")).toBeNull());

  // Off again, this time by the person: no edit of theirs did it.
  act(() => arrive({ enabled: false } as Partial<AutomationDefinition>));

  expect(onSwitch().getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByText("Switched off")).toBeNull();
});
