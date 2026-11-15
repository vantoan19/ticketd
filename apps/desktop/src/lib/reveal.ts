import { workspaceClient } from "@/lib/api/workspace";
import { failureText } from "@/lib/api/describe-failure";
import { fileManagerName } from "@/lib/platform";

/** Shows a file in the platform's file manager. Resolves to why it failed, or null on success. */
export async function revealFile(path: string): Promise<string | null> {
  try {
    await workspaceClient.reveal(path);
    return null;
  } catch (reason) {
    return failureText(reason, `show the file in ${fileManagerName()}`);
  }
}
