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
 * A path as its folder and its file name, cut from the start: a long folder keeps its
 * last parts behind "…/", and the name is never cut. `folder` ends in "/" (or is empty
 * for a bare name), so `folder + name` reads as the path.
 */
export function splitPath(
  path: string,
  max = 48,
): { folder: string; name: string } {
  const whole = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = whole.lastIndexOf("/");
  const name = whole.slice(at + 1);
  const folder = whole.slice(0, at + 1);
  if (whole.length <= max || !folder) return { folder, name };
  // Keep the folder's last parts that fit beside the name and the "…/".
  const room = max - name.length - 2;
  const parts = folder.split("/").filter(Boolean);
  let kept = "";
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const next = `${parts[i]}/${kept}`;
    if (next.length > room) break;
    kept = next;
  }
  return { folder: `…/${kept}`, name };
}

// A search scope that names a place; a glob (one with * ? [ or {) is a pattern.
export const scopeIsPath = (scope: string) => !/[*?[{]/.test(scope);
