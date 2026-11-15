import { isMacPlatform } from "@/lib/platform";

/*
 * The one keyboard registry (proposal P18). Settings › Keyboard shortcuts,
 * tooltips (`shortcutLabel`), menu shortcut slots and `aria-keyshortcuts`
 * all read from it, so a key is written once. List only keys that work:
 * add an entry in the same change as its handler, and match events with
 * `matchesShortcut` where a handler can.
 *
 * Keys are written platform-neutral: "Mod" is ⌘ on macOS and Ctrl elsewhere,
 * "Shift" and "Alt" are the modifiers, anything else is the key itself
 * ("N", "Enter", "↑", "F2", "1–9").
 */

export type ShortcutScope =
  | "Everywhere"
  | "Lists"
  | "Ticket"
  | "Plans"
  | "Chat"
  | "First run"
  | "Dialogs and menus";

export type Shortcut = {
  id: string;
  /** Alternatives, each a chord of keys pressed together. */
  keys: string[][];
  /** Alternatives of ordered chords (G, then I); never simultaneous keys. */
  sequences?: readonly (readonly (readonly string[])[])[];
  scope: ShortcutScope;
  label: string;
  /** One sentence where the label alone would surprise. */
  note?: string;
};

export const SCOPE_CAPTIONS: Record<ShortcutScope, string> = {
  Everywhere: "These work wherever you are in ticketd.",
  Lists: "In any list of tickets. The list is one stop for Tab.",
  Ticket: "On the open ticket.",
  Plans: "On a Plan or the Plans page, as noted.",
  Chat: "In a Chat's message box and its requests.",
  "Dialogs and menus": "In any dialog, menu or sheet.",
  "First run": "While the guide button or its palette command is focused.",
};

export const SHORTCUTS = [
  ...(
    [
      [
        "inbox-primary",
        ["Mod", "Enter"],
        "Run the Inbox entry’s suggested action",
      ],
      ["inbox-open", ["Enter"], "Open the approval in Chat"],
      ["inbox-read", ["E"], "Mark the Inbox entry read or unread"],
      ["inbox-reply", ["R"], "Reply to the Inbox entry on its Ticket"],
      ["inbox-remind", ["H"], "Snooze or remind me about the Inbox Ticket"],
      ["inbox-next", ["J"], "Read the next Inbox entry"],
      ["inbox-previous", ["K"], "Read the previous Inbox entry"],
    ] as const
  ).map(([id, keys, label]) => ({
    id,
    keys: [[...keys]],
    scope: "Lists" as const,
    label,
  })),
  {
    id: "go-automations",
    keys: [],
    scope: "Everywhere",
    label: "Go to Automations",
    note: "Available in the command palette while Chat is enabled.",
  },
  {
    id: "command-palette",
    keys: [["Mod", "K"]],
    scope: "Everywhere",
    label: "Search tickets and go anywhere",
    note: "In the rich editor, this inserts a link.",
  },
  ...(
    [
      ["go-inbox", "I", "Go to Inbox"],
      ["go-all", "A", "Go to All tickets"],
      ["go-ready", "R", "Go to Ready"],
      ["go-chats", "C", "Go to Chats"],
      ["go-documents", "D", "Go to Documents"],
      ["go-settings", "S", "Go to Settings"],
      ["go-trash", "X", "Go to Trash"],
    ] as const
  ).map(([id, key, label]) => ({
    id,
    keys: [],
    sequences: [[["G"], [key]]],
    scope: "Everywhere" as const,
    label,
    note:
      id === "go-chats"
        ? "Not while typing or using an overlay. Requires Chat to be enabled."
        : "Not while typing or using an overlay.",
  })),
  {
    id: "new-ticket",
    keys: [["C"]],
    scope: "Everywhere",
    label: "New ticket",
    note: "Opens over the current view; not while typing.",
  },
  {
    id: "capture",
    keys: [["Mod", "Shift", "N"]],
    scope: "Everywhere",
    label: "Capture a thought",
  },
  {
    id: "add-to-chat",
    keys: [["Mod", "L"]],
    scope: "Everywhere",
    label: "Add the selected text to a Chat",
    note: "Select text in a Document, a description or an update first.",
  },
  {
    id: "settings-search",
    keys: [["Mod", "F"]],
    scope: "Everywhere",
    label: "Search Settings",
    note: "While Settings is open.",
  },
  ...(
    [
      ["attachments-search", [["/"]], "Search files"],
      [
        "attachments-move",
        [["↑"], ["↓"], ["J"], ["K"], ["Home"], ["End"]],
        "Move between Attachments",
      ],
      ["attachments-add", [["Mod", "Shift", "U"]], "Add files"],
      ["attachments-open", [["O"]], "Open file"],
      ["attachments-more", [["."]], "More file actions"],
      ["attachments-back", [["Escape"]], "Back to Attachments"],
    ] as const
  ).map(([id, keys, label]) => ({
    id,
    keys: keys.map((chord) => [...chord]),
    label,
    scope: "Lists" as const,
  })),
  {
    id: "documents-search",
    keys: [["/"]],
    scope: "Lists",
    label: "Search this Documents list",
  },
  {
    id: "documents-move",
    keys: [["↑"], ["↓"], ["J"], ["K"], ["Home"], ["End"]],
    scope: "Lists",
    label: "Move between Documents",
  },
  {
    id: "documents-pin",
    keys: [["P"]],
    scope: "Lists",
    label: "Pin or unpin the focused Document",
  },
  {
    id: "documents-time",
    keys: [["→"]],
    scope: "Lists",
    label: "Focus the Document’s exact updated time",
    note: "Escape or Left arrow returns to the row.",
  },
  {
    id: "board-move",
    keys: [["↑"], ["↓"], ["←"], ["→"]],
    scope: "Lists",
    label: "Move between cards and columns",
  },
  {
    id: "workspace-graph-filter",
    keys: [["F"]],
    scope: "Lists",
    label: "Filter the Workspace graph",
  },
  {
    id: "workspace-graph-view",
    keys: [["Shift", "V"]],
    scope: "Lists",
    label: "Switch Workspace graph between Graph and List",
  },
  {
    id: "list-move",
    keys: [["↑"], ["↓"], ["J"], ["K"]],
    scope: "Lists",
    label: "Move between tickets",
  },
  {
    id: "list-ends",
    keys: [["Home"], ["End"]],
    scope: "Lists",
    label: "Go to the first or last ticket",
  },
  {
    id: "list-open",
    keys: [["Enter"]],
    scope: "Lists",
    label: "Open the focused ticket",
  },
  {
    id: "list-select",
    keys: [["Space"]],
    scope: "Lists",
    label: "Select the focused ticket for bulk changes",
  },
  {
    id: "list-select-range",
    keys: [
      ["Shift", "↑"],
      ["Shift", "↓"],
    ],
    scope: "Lists",
    label: "Extend the selection",
    note: "Shift-click a checkbox to select the range from the last one.",
  },
  {
    id: "list-select-all",
    keys: [["Mod", "A"]],
    scope: "Lists",
    label: "Select every listed ticket",
  },
  {
    id: "inbox-mark",
    keys: [["E"]],
    scope: "Lists",
    label: "Mark the focused Inbox entry read or unread",
  },
  {
    id: "inbox-snooze",
    keys: [["H"]],
    scope: "Lists",
    label: "Snooze the focused Inbox reminder",
  },
  {
    id: "list-clear-selection",
    keys: [["Esc"]],
    scope: "Lists",
    label: "Clear the selection",
  },
  {
    id: "resize",
    keys: [["←"], ["→"]],
    scope: "Lists",
    label: "Resize the list and detail",
    note: "Focus the divider first.",
  },
  ...(
    [
      ["ticket-status", "S", "Change status"],
      ["ticket-project", "P", "Change project"],
      ["ticket-plan", "L", "Move to Plan"],
      ["ticket-tags", "T", "Edit tags"],
      ["ticket-reminder", "H", "Remind me"],
      ["ticket-update", "R", "Write an update"],
    ] as const
  ).map(([id, key, label]) => ({
    id,
    keys: [[key]],
    scope: "Ticket" as const,
    label,
    note: "On the focused ticket in a list or board, or the open ticket; not while typing.",
  })),
  {
    id: "ticket-copy-reference",
    keys: [["Mod", "Shift", "C"]],
    scope: "Ticket",
    label: "Copy reference",
    note: "The focused ticket in a list or board, or the open ticket.",
  },
  {
    id: "ticket-edit",
    keys: [["E"]],
    scope: "Ticket",
    label: "Edit the description",
  },
  {
    id: "create-submit",
    keys: [["Mod", "Enter"]],
    scope: "Ticket",
    label: "Create the ticket",
    note: "In the New ticket dialog.",
  },
  {
    id: "update-post",
    keys: [["Mod", "Enter"]],
    scope: "Ticket",
    label: "Post the update, or save the one being edited",
    note: "In the update composer.",
  },
  {
    id: "editing-done",
    keys: [["Esc"]],
    scope: "Ticket",
    label: "Finish editing the description or a Document",
    note: "While editing; nothing is discarded.",
  },
  {
    id: "flow-full-graph",
    keys: [["Shift", "G"]],
    scope: "Plans",
    label: "Open the Plan’s full graph",
    note: "While a Flow card has focus.",
  },
  {
    id: "flow-move",
    keys: [["J"], ["K"], ["↑"], ["↓"], ["←"], ["→"]],
    scope: "Plans",
    label: "Select a Flow ticket",
    note: "While a Flow card has focus.",
  },
  {
    id: "flow-open",
    keys: [["Enter"]],
    scope: "Plans",
    label: "Open the selected Flow ticket",
  },
  {
    id: "new-plan",
    keys: [["N"]],
    scope: "Plans",
    label: "New Plan",
    note: "On the Plans page; not while typing.",
  },
  {
    id: "plan-rename",
    keys: [["F2"]],
    scope: "Plans",
    label: "Rename the Plan",
  },
  {
    id: "chat-send",
    keys: [["Enter"]],
    scope: "Chat",
    label: "Send, steer or queue, as the button says",
  },
  {
    id: "chat-queue",
    keys: [["Mod", "Enter"]],
    scope: "Chat",
    label: "Queue the message while a turn runs",
  },
  {
    id: "chat-model",
    keys: [["Mod", "Shift", "M"]],
    scope: "Chat",
    label: "Choose the harness, model and effort",
  },
  {
    id: "chat-stop",
    keys: [["Esc"]],
    scope: "Chat",
    label: "Stop the turn",
    note: "From an empty message box, when no menu or dialog is open.",
  },
  {
    id: "chat-request",
    keys: [["↑"]],
    scope: "Chat",
    label: "Move to the waiting request",
    note: "From an empty message box.",
  },
  {
    id: "chat-pick",
    keys: [["1–9"]],
    scope: "Chat",
    label: "Pick a request's option",
  },
  {
    id: "chat-undo-suggestion",
    keys: [["Mod", "Z"]],
    scope: "Chat",
    label: "Take back a suggestion you just chose",
  },
  {
    id: "create-expand",
    keys: [],
    scope: "Dialogs and menus",
    label: "Expand the New ticket draft",
  },
  {
    id: "palette-drill",
    keys: [["Tab"], ["→"]],
    scope: "Dialogs and menus",
    label: "Open a palette action's options",
  },
  {
    id: "palette-back",
    keys: [["Backspace"]],
    scope: "Dialogs and menus",
    label: "Back to palette actions",
    note: "From an empty search in a drill-in.",
  },
  {
    id: "palette-pick",
    keys: [["1–9"]],
    scope: "Dialogs and menus",
    label: "Pick a palette option",
    note: "Inside a property drill-in.",
  },
  {
    id: "close",
    keys: [["Esc"]],
    scope: "Dialogs and menus",
    label: "Close the top surface",
    note: "Closes only the foremost dialog, menu or sheet, and never throws away a draft.",
  },
  ...(
    [
      ["go-agent-skills", "Open Agent skills"],
      ["go-sync", "Open Google Drive sync"],
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    keys: [["Enter"]],
    scope: "First run" as const,
    note: "While the guide button or its palette command is focused.",
  })),
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** The registry entry for an id. */
export function shortcut(id: ShortcutId): Shortcut {
  const found = SHORTCUTS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown shortcut ${id}`);
  return found as Shortcut;
}

const MAC_GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Enter: "↵",
};
const OTHER_NAMES: Record<string, string> = {
  Mod: "Ctrl",
};

/** One key as this platform writes it: ⌘ ⇧ ⌥ on macOS, Ctrl Shift Alt elsewhere. */
export function keyGlyph(key: string, mac = isMacPlatform()): string {
  return (mac ? MAC_GLYPHS[key] : OTHER_NAMES[key]) ?? key;
}

/** A chord as one label for a tooltip: "⇧⌘N" on macOS, "Ctrl+Shift+N" elsewhere. */
export function chordLabel(chord: readonly string[], mac = isMacPlatform()) {
  if (!mac) return chord.map((key) => keyGlyph(key, false)).join("+");
  // macOS writes modifiers in a fixed order before the key: ⌃⌥⇧⌘.
  const order = ["Alt", "Shift", "Mod"];
  const modifiers = order.filter((key) => chord.includes(key));
  const rest = chord.filter((key) => !order.includes(key));
  return [...modifiers, ...rest].map((key) => keyGlyph(key, true)).join("");
}

/** The first alternative as a tooltip label: "⌘L" or "G then I". */
export function shortcutLabel(id: ShortcutId, mac = isMacPlatform()): string {
  const entry = shortcut(id);
  const sequence = entry.sequences?.[0];
  if (sequence)
    return sequence.map((chord) => chordLabel(chord, mac)).join(" then ");
  const [first = []] = entry.keys;
  return chordLabel(first, mac);
}

const ARIA_NAMES: Record<string, string> = {
  Shift: "Shift",
  Alt: "Alt",
  Esc: "Escape",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "←": "ArrowLeft",
  "→": "ArrowRight",
};

/** The `aria-keyshortcuts` value for this platform: "Meta+Shift+N" on macOS. */
export function ariaKeyShortcuts(id: ShortcutId, mac = isMacPlatform()) {
  return shortcut(id)
    .keys.map((chord) =>
      chord
        .map((key) =>
          key === "Mod" ? (mac ? "Meta" : "Control") : (ARIA_NAMES[key] ?? key),
        )
        .join("+"),
    )
    .join(" ");
}

const SPOKEN: Record<string, string> = {
  Mod: "Command",
  "↑": "Up arrow",
  "↓": "Down arrow",
  "←": "Left arrow",
  "→": "Right arrow",
  Esc: "Escape",
  "1–9": "1 to 9",
};

/** What a screen reader says for the keys: "Command plus Shift plus N". */
export function spokenKeys(
  keys: readonly (readonly string[])[],
  mac = isMacPlatform(),
  sequences?: Shortcut["sequences"],
): string {
  if (sequences?.length)
    return sequences
      .map((sequence) =>
        sequence.map((chord) => spokenKeys([chord], mac)).join(" then "),
      )
      .join(" or ");
  return keys
    .map((chord) =>
      chord
        .map((key) =>
          key === "Mod" && !mac ? "Control" : (SPOKEN[key] ?? key),
        )
        .join(" plus "),
    )
    .join(" or ");
}

/** Whether a keyboard event is one of the shortcut's chords on this platform. */
export function matchesShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
  id: ShortcutId,
  mac = isMacPlatform(),
): boolean {
  return shortcut(id).keys.some((chord) => {
    const mod = chord.includes("Mod");
    const wantMeta = mod && mac;
    const wantCtrl = mod && !mac;
    if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
    if (event.shiftKey !== chord.includes("Shift")) return false;
    if (event.altKey !== chord.includes("Alt")) return false;
    const key = chord.find((part) => !["Mod", "Shift", "Alt"].includes(part));
    if (!key) return false;
    const pressed = event.key === " " ? "Space" : event.key;
    return pressed.toLowerCase() === (ARIA_NAMES[key] ?? key).toLowerCase();
  });
}
