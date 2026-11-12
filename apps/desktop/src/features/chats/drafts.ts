/** What was typed into each Chat's composer, kept while the app is open. */
export const drafts = new Map<string, string>();
/** Why text was carried into a Chat, said once when that Chat opens. */
export const arrivals = new Map<string, string>();

/**
 * Puts text that could not be sent into a Chat's composer, with the reason,
 * so opening the Chat shows both and nothing typed is lost.
 */
export function carryIntoChat(id: string, text: string, reason: string) {
  drafts.set(id, text);
  arrivals.set(id, reason);
}
