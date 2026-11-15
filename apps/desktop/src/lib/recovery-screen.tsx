import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { toFailure } from "@/lib/api/bridge-failure";
import { workspaceClient } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";

/** The plain cause of a workspace that cannot be opened, by kind. */
function cause(reason: unknown): string {
  const failure = toFailure(reason);
  switch (failure.kind) {
    case "workspace_unreadable":
      return "The file can't be read: it may have moved, or ticketd lacks permission.";
    case "workspace_read_only":
      return "Its folder is read-only, so ticketd can't prepare it.";
    case "workspace_locked":
      return "Another ticketd operation is using it. Wait for it to finish, then retry.";
    case "disk_full":
      return "The disk is full, so ticketd can't prepare it.";
    default:
      // Other causes are technical; the raw text waits under Details.
      return "The file couldn't be opened or prepared.";
  }
}

/**
 * The workspace file as the shared PathText (name, then its folder shortened
 * in the middle, the full path in a tooltip), with Copy path and Show in
 * Finder beside it.
 */
function WorkspacePath({ path }: { path: string }) {
  return (
    <div className="recovery-path">
      <PathText path={path} />
      <div className="recovery-path-actions">
        <CopyButton text={path} label="Copy path" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void workspaceClient.reveal(path).catch(() => {})}
        >
          <FolderOpen aria-hidden />
          Show in {fileManagerName()}
        </Button>
      </div>
    </div>
  );
}

/**
 * Startup: the workspace could not be opened, so nothing else can show. A calm
 * full-window screen in the app's theme: wordmark, what happened in plain
 * words, the file, Retry, and the raw cause only under Details.
 */
export function RecoveryScreen({
  reason,
  onRetry,
}: {
  reason: unknown;
  onRetry: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void workspaceClient.location().then(
      (value) => {
        if (active) setPath(value);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <main className="recovery-screen">
      <div role="alert" className="recovery-screen-body">
        <p className="recovery-wordmark">ticketd</p>
        <h1 className="recovery-title">ticketd can't open this workspace</h1>
        <p className="recovery-sentence">
          {cause(reason)} Nothing in it was changed.
        </p>
        {path && <WorkspacePath path={path} />}
        <div className="recovery-actions">
          <Button type="button" size="sm" onClick={onRetry}>
            Retry
          </Button>
          <FailureDetails details={toFailure(reason).message} />
        </div>
      </div>
    </main>
  );
}
