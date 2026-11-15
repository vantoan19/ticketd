import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FailureCaption } from "@/components/ui/failure-alert";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

/**
 * Renames a file in place, in the preview header: the title becomes the
 * field, with Save and Cancel beside it (never a dialog over the preview).
 * Only the name ticketd shows changes; links keep their text. Enter saves,
 * Escape cancels. A save that failed keeps the draft and its request
 * identity, so Retry repeats the same request.
 */
export function RenameAttachment({
  file,
  onClose,
  onRenamed,
}: {
  file: Attachment;
  onClose: () => void;
  onRenamed: (file: Attachment) => void;
}) {
  const [name, setName] = useState(file.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const request = useRef<{ name: string; id: string } | null>(null);
  const blocked = name.trim() ? null : "Enter a name.";
  async function save() {
    if (blocked || busy) return;
    if (name === file.display_name) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    if (request.current?.name !== name)
      request.current = { name, id: crypto.randomUUID() };
    try {
      const renamed = await attachments.rename(
        file.id,
        name,
        request.current.id,
      );
      onRenamed(renamed);
      onClose();
    } catch (reason) {
      setError(describeFailure(reason, "rename the file"));
    } finally {
      setBusy(false);
    }
  }
  const saveButton = (
    <Button type="submit" size="sm" disabled={busy || blocked !== null}>
      {busy ? "Saving…" : "Save name"}
    </Button>
  );
  return (
    <form
      className="attachment-rename"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        aria-label="Display name"
        className="h-8"
        autoFocus
        value={name}
        disabled={busy}
        aria-invalid={blocked ? true : undefined}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      {blocked ? (
        <Tooltip content={blocked}>
          <span tabIndex={0} className="inline-flex">
            {saveButton}
          </span>
        </Tooltip>
      ) : (
        saveButton
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onClose}
      >
        Cancel
      </Button>
      {error && (
        <div className="attachment-rename-failure">
          <FailureCaption
            label="Not renamed"
            failure={error}
            onRetry={() => void save()}
          />
        </div>
      )}
    </form>
  );
}
