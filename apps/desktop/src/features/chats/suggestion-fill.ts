import type { LinkedRecord, Suggestion } from "@/features/chats/client";

/** What choosing a suggestion writes in the box and links to the Chat. */
export function suggestionFill(suggestion: Suggestion): {
  prompt: string;
  links: LinkedRecord[];
} {
  switch (suggestion.kind) {
    case "continue": {
      const { reference, title } = suggestion.ticket;
      return {
        prompt: `Continue ${reference} (${title}). Read its latest update and linked Documents first, then pick up where it left off.`,
        links: [suggestion.ticket],
      };
    }
    case "review": {
      const { reference, title } = suggestion.ticket;
      return {
        prompt: `Review ${reference} (${title}) against its description and evidence. List anything missing before it can be Done.`,
        links: [suggestion.ticket],
      };
    }
    case "triage":
      return {
        prompt: `Go through my ${suggestion.count} unread Inbox ${suggestion.count === 1 ? "item" : "items"}. For each, say what changed and what I should do next.`,
        links: suggestion.links,
      };
  }
}
