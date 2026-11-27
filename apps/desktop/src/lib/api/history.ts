import { invoke } from "@/lib/api/bridge-failure";
import { creditedSubAgentSchema, type CreditedSubAgent } from "@/lib/api/credit";
export type Entry = {
  kind: string;
  from_value: string;
  to_value: string;
  timestamp: string;
  editing_agent: string | null;
  /** The sub-agent that made this change, on this computer. */
  credited_to?: CreditedSubAgent | null | undefined;
};
function parseEntries(value: unknown): Entry[] {
  if (!Array.isArray(value))
    throw new Error("Invalid history returned by workspace");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null)
      throw new Error("Invalid history entry");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.kind !== "string" ||
      typeof entry.from_value !== "string" ||
      typeof entry.to_value !== "string" ||
      typeof entry.timestamp !== "string" ||
      !(entry.editing_agent === null || typeof entry.editing_agent === "string")
    )
      throw new Error("Invalid history entry");
    const credited = creditedSubAgentSchema.nullish().safeParse(entry.credited_to);
    return {
      ...(credited.success && credited.data && { credited_to: credited.data }),
      kind: entry.kind,
      from_value: entry.from_value,
      to_value: entry.to_value,
      timestamp: entry.timestamp,
      editing_agent: entry.editing_agent,
    };
  });
}
export const historyClient = {
  async list(reference: string) {
    return parseEntries(await invoke("ticket_history", { reference }));
  },
};
