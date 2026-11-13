import { z } from "zod";
import type { HarnessOptions, SettingOption } from "@/features/chats/client";

/**
 * New Chat's model, effort and permission for one harness (#368). `null` is
 * the harness's own setting: nothing is passed and the harness decides.
 */
export type Pick = {
  model: string | null;
  effort: string | null;
  permission: string | null;
};

export const NO_PICK: Pick = { model: null, effort: null, permission: null };

const STORAGE_KEY = "ticketd.chat-picks";
const picksSchema = z.record(
  z.string(),
  z.object({
    model: z.string().nullable().catch(null),
    effort: z.string().nullable().catch(null),
    permission: z.string().nullable().catch(null),
  }),
);

function stored(): Record<string, Pick> {
  try {
    return picksSchema.parse(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"),
    );
  } catch {
    return {};
  }
}

/** The last pick made for a harness on this computer, as the next New Chat's start. */
export function rememberedPick(harnessId: string): Pick {
  return stored()[harnessId] ?? NO_PICK;
}

/** Remembers a pick for the harness's next New Chat. Never fails a choice. */
export function rememberPick(harnessId: string, pick: Pick) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored(), [harnessId]: pick }),
    );
  } catch {
    // Remembering is a convenience; the choice itself still applies.
  }
}

const HARNESS_KEY = "ticketd.chat-harness";

/** The harness the last New Chat was set to on this computer. */
export function rememberedHarness(): string | null {
  try {
    return localStorage.getItem(HARNESS_KEY);
  } catch {
    return null;
  }
}

export function rememberHarness(harnessId: string) {
  try {
    localStorage.setItem(HARNESS_KEY, harnessId);
  } catch {
    // A convenience only.
  }
}

type Model = HarnessOptions["models"][number];

/** The model a pick runs on: the picked one, else the one the harness marks default. */
export function modelOf(
  options: HarnessOptions | null | undefined,
  pick: Pick,
): Model | undefined {
  const models = options?.models ?? [];
  return (
    models.find((model) => model.id === pick.model) ??
    models.find((model) => model.is_default)
  );
}

/** The efforts the pick's model offers, lowest first. */
export const effortsOf = (
  options: HarnessOptions | null | undefined,
  pick: Pick,
): SettingOption[] => modelOf(options, pick)?.efforts ?? [];

/**
 * Keeps only what the harness offers now: a remembered model it no longer
 * lists, an effort the model does not take, or a permission it does not let
 * ticketd choose falls back to the harness's own setting.
 */
export function offeredPick(
  options: HarnessOptions | null | undefined,
  pick: Pick,
): Pick {
  if (!options) return NO_PICK;
  const model = options.models.some(
    (item) => item.id === pick.model && item.allowed,
  )
    ? pick.model
    : null;
  const effort = effortsOf(options, { ...pick, model }).some(
    (item) => item.id === pick.effort && item.allowed,
  )
    ? pick.effort
    : null;
  const permission =
    options.permission?.changeable &&
    options.permission.options.some(
      (item) => item.id === pick.permission && item.allowed,
    )
      ? pick.permission
      : null;
  return { model, effort, permission };
}

/** Choosing a model keeps the effort only when the new model takes it. */
export function withModel(
  options: HarnessOptions | null | undefined,
  pick: Pick,
  model: string,
): Pick {
  return offeredPick(options, { ...pick, model });
}
