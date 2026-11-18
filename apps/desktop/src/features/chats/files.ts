import type { LinkedRecord } from "@/features/chats/client";
import { createContext } from "react";

/**
 * What a transcript's file names need from their Chat: its folder's name, and how
 * to open a file the harness named (relative to that folder). Without `open` a
 * name is plain text.
 */
export type ChatFiles = {
  folder: string;
  /** Fails with a `gone` ChatError when the file is no longer there. */
  open?: (path: string) => Promise<void>;
  /** A step's whole output by its tool call, for a row that carries only its end. */
  output?: (toolId: string) => Promise<string | null>;
};
export const ChatFilesContext = createContext<ChatFiles>({ folder: "" });

/** The Chat's linked records, so a sent message's mentions stay links, and which are in the trash. */
export const SentLinksContext = createContext<{
  links: LinkedRecord[];
  trashed: string[];
}>({ links: [], trashed: [] });

/**
 * The name to show for each path: its last part, or its folder and last part when
 * another path shares that name ("auth/index.ts", "api/index.ts").
 */
export function shownNames(paths: string[]): string[] {
  const parts = paths.map((path) => path.split("/").filter(Boolean));
  const base = (each: string[]) => each.at(-1) ?? "";
  return parts.map((each, index) => {
    const repeated = parts.some(
      (other, at) => at !== index && base(other) === base(each),
    );
    return repeated && each.length > 1 ? each.slice(-2).join("/") : base(each);
  });
}
