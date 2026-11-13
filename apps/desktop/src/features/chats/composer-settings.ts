import type {
  ChatState,
  HarnessSetting,
  SettingChange,
} from "@/features/chats/client";

/** The wording and arithmetic behind the composer's harness triggers (#368). */
export type Setting = "model" | "effort" | "permission";

/** The effort that reads as the most, with no bars of its own in the menu. */
const MAX = "max";

/**
 * How many bars an effort draws and how many are filled: up to four, rising
 * with the harness's own order of efforts. Max fills them all in the trigger
 * and has an empty slot in the menu (`null`), so the words line up.
 */
export function effortBars(
  options: readonly { id: string }[],
  id: string | null | undefined,
  inMenu = false,
): { count: number; filled: number } | null {
  const ranked = options.filter((option) => option.id !== MAX);
  const count = Math.min(ranked.length, 4);
  if (count === 0 || !id) return null;
  if (id === MAX) return inMenu ? null : { count, filled: count };
  const index = ranked.findIndex((option) => option.id === id);
  if (index < 0) return null;
  return { count, filled: Math.ceil(((index + 1) * count) / ranked.length) };
}

export const labelOf = (
  setting: HarnessSetting | null | undefined,
  id?: string | null,
) => setting?.options.find((option) => option.id === id)?.label ?? id ?? "";

/** The current value, else the harness's default. */
export const currentOf = (setting: HarnessSetting) =>
  setting.current ??
  setting.options.find((option) => option.is_default)?.id ??
  null;

/** A change is on its way: held for the turn's end, or sent and not answered. */
export const changing = (setting: HarnessSetting | null | undefined) =>
  setting?.change?.state === "held" || setting?.change?.state === "sent";

/** A change the person asked for in this view, and what the host first said. */
export type AskedChange = { setting: Setting; outcome: SettingChange };

/**
 * The one line a refused or unconfirmed change leaves at the top of the dock;
 * the trigger keeps the value in effect. Said only for a change asked for in
 * this view, as the host last reports it (a held change settles later).
 */
export function settingLine(
  chat: ChatState,
  asked: AskedChange | null,
): string | null {
  if (!asked) return null;
  const harness = chat.harness.name;
  const setting = chat.settings?.[asked.setting];
  const outcome =
    setting?.change?.value === asked.outcome.value
      ? setting.change
      : asked.outcome;
  const wanted = labelOf(setting, outcome.value);
  const reason = outcome.reason?.replace(/\.$/, "");
  switch (outcome.state) {
    case "refused":
      return reason
        ? `${harness} didn't switch to ${wanted}: ${reason}.`
        : `${harness} didn't switch to ${wanted}.`;
    case "unsupported":
      return `${harness} can't switch to ${wanted} in this session.`;
    case "unconfirmed": {
      const kept = setting ? labelOf(setting, currentOf(setting)) : "";
      return kept
        ? `${wanted} not confirmed. ${harness} may still be using ${kept}.`
        : `${wanted} not confirmed.`;
    }
    default:
      return null;
  }
}
