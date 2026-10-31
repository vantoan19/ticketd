import { workspaceClient } from "@/lib/api/workspace";

/** Shows a file in the platform's file manager. Resolves to why it failed, or null on success. */
export async function revealFile(path: string): Promise<string | null> {
  try {
    await workspaceClient.reveal(path);
    return null;
  } catch (reason) {
    return `Could not show the file: ${String(reason)}`;
  }
}
