import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";

/**
 * "Show in Finder" ("Show in Explorer" on Windows) for a path shown with
 * PathText: the one file action beside a path. `button` (the default) is a
 * ghost sm button with the folder icon; `icon` is an IconButton with the same
 * words as its tooltip, for dense meta lines. A failure goes to `onFailure`
 * for the caller to show where the person clicked; success passes null, so a
 * shown failure clears.
 */
export function RevealButton({
  path,
  onFailure,
  display = "button",
  subject,
  disabled,
}: {
  path: string;
  onFailure?: (failure: FailureDescription | null) => void;
  display?: "button" | "icon";
  /** Added to the accessible name only, so several in a list stay distinct. */
  subject?: string;
  disabled?: boolean;
}) {
  const label = `Show in ${fileManagerName()}`;
  // The tooltip keeps the short label; the name tells rows apart.
  const name: object = subject ? { "aria-label": `${label}: ${subject}` } : {};
  async function reveal() {
    try {
      await workspaceClient.reveal(path);
      onFailure?.(null);
    } catch (reason) {
      onFailure?.(
        describeFailure(reason, `show the file in ${fileManagerName()}`),
      );
    }
  }
  if (display === "icon")
    return (
      <IconButton
        label={label}
        {...name}
        {...(disabled !== undefined && { disabled })}
        onClick={() => void reveal()}
      >
        <FolderOpen aria-hidden="true" />
      </IconButton>
    );
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      {...name}
      {...(disabled !== undefined && { disabled })}
      onClick={() => void reveal()}
    >
      <FolderOpen aria-hidden="true" />
      {label}
    </Button>
  );
}
