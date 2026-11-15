import { useEffect, useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { useCopy } from "@/components/ui/use-copy";
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
 * The workspace file: name in mono, folder muted on its own line, the full
 * path in the title, never wrapped mid-word, with Copy path and Show in Finder.
 * TODO(R2.6): replace with the shared PathText once it lands in components/ui.
 */
function WorkspacePath({ path }: { path: string }) {
  const { copied, copy } = useCopy();
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(separator + 1);
  const folder = separator > 0 ? path.slice(0, separator) : "";
  return (
    <div className="recovery-path">
      <div className="recovery-path-text">
        <span className="recovery-path-name">{name}</span>
        {folder && <span className="recovery-path-folder">{folder}</span>}
      </div>
      <div className="recovery-path-actions">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Copied" : "Copy path"}
          onClick={() => void copy("Path", path)}
        >
          <Copy aria-hidden />
        </Button>
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
