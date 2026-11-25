import type { Token } from "@/features/chats/composer-mentions";
import type { ChatClient } from "@/features/chats/client";
import { ComposerAttachments } from "@/features/chats/composer-attachments";

/** What was typed into each Chat's composer, kept while the app is open. */
export const drafts = new Map<string, string>();
/** The mentions in each draft, as long as its text is the one they were made in. */
export const draftTokens = new Map<string, { text: string; tokens: Token[] }>();
const draftAttachments = new WeakMap<
  ChatClient,
  Map<string, ComposerAttachments>
>();

export function attachmentsOf(
  client: ChatClient,
  id: string,
): ComposerAttachments {
  const drafts =
    draftAttachments.get(client) ?? new Map<string, ComposerAttachments>();
  if (!draftAttachments.has(client)) draftAttachments.set(client, drafts);
  const attachments =
    drafts.get(id) ?? new ComposerAttachments(client.captureAttachment);
  if (!drafts.has(id)) drafts.set(id, attachments);
  return attachments;
}
/** The draft's mentions, or none when its text changed without them. */
export const tokensOf = (id: string) => {
  const kept = draftTokens.get(id);
  return kept && kept.text === drafts.get(id) ? kept.tokens : [];
};
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
