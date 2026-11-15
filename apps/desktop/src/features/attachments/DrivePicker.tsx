import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { attachments, type DriveConfiguration } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { DriveSetupNotice } from "./DriveSetupNotice";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import type { DriveChoice } from "./drive-choices";

/**
 * The Google Drive tab: choose files in the browser picker, then keep or drop
 * each one with its checkbox. The picker owns the chosen files and adds them
 * from its footer ("Add selected"). Unconfigured Drive shows one line and the
 * way to Settings, never a disabled button.
 */
export function DrivePicker({
  files,
  onFilesChange,
  busy,
  onBusyChange,
  onFailure,
  onOpenSettings,
}: {
  files: DriveChoice[];
  onFilesChange: (next: DriveChoice[]) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onFailure: (failure: FailureDescription | null) => void;
  onOpenSettings?: (() => void) | undefined;
}) {
  const [configuration, setConfiguration] = useState<DriveConfiguration | null>(
    null,
  );
  const [selecting, setSelecting] = useState(false);
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  const report = useRef(onFailure);
  useEffect(() => {
    report.current = onFailure;
  });
  useEffect(() => {
    mounted.current = true;
    void attachments
      .driveConfiguration()
      .then((value) => {
        if (mounted.current) setConfiguration(value);
      })
      .catch((reason: unknown) => {
        if (mounted.current)
          report.current(describeFailure(reason, "read the Drive setup"));
      });
    return () => {
      mounted.current = false;
      if (operation.current)
        void attachments
          .cancelDriveSelection(operation.current)
          .catch(() => {});
    };
  }, []);
  async function choose() {
    const id = crypto.randomUUID();
    operation.current = id;
    setSelecting(true);
    onBusyChange(true);
    onFailure(null);
    try {
      const selected = await attachments.selectDrive(id);
      if (!mounted.current || operation.current !== id) return;
      onFilesChange(
        selected.files.map((file) => ({
          file,
          requestId: crypto.randomUUID(),
          selected: true,
        })),
      );
      onFailure(
        selected.failures.length
          ? {
              code: "failed",
              title: `Couldn't select ${selected.failures.length} ${selected.failures.length === 1 ? "file" : "files"}`,
              sentence: "Drive didn't allow them. The others are ready to add.",
              action: null,
              details: selected.failures.join("\n"),
            }
          : null,
      );
    } catch (reason) {
      if (mounted.current && operation.current === id)
        onFailure(describeFailure(reason, "choose files in Google Drive"));
    } finally {
      if (operation.current === id) {
        operation.current = null;
        if (mounted.current) {
          onBusyChange(false);
          setSelecting(false);
        }
      }
    }
  }
  async function cancel() {
    if (!operation.current) return;
    const id = operation.current;
    try {
      await attachments.cancelDriveSelection(id);
    } catch (reason) {
      if (mounted.current)
        onFailure(describeFailure(reason, "cancel the Drive selection"));
    }
  }
  if (configuration && !configuration.configured)
    return (
      <div className="attachment-existing">
        <DriveSetupNotice
          configuration={configuration}
          onOpenSettings={onOpenSettings}
        />
      </div>
    );
  return (
    <div className="attachment-existing">
      <div className="attachment-drive-choose">
        <p>
          Link files from your Google Drive. They stay in Drive with their
          sharing unchanged; only the files you choose are shared with ticketd.
        </p>
        {selecting ? (
          <>
            <p role="status" className="attachment-hint">
              Choose files in your browser, then come back here.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void cancel()}
            >
              Cancel Drive selection
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !configuration}
            onClick={() => void choose()}
          >
            {files.length ? "Choose other files…" : "Choose in Google Drive"}
          </Button>
        )}
      </div>
      {files.length > 0 && (
        <ul aria-label="Selected Drive files">
          {files.map((choice) => (
            <li key={choice.file.id}>
              <label
                className="attachment-choice"
                data-checked={choice.selected || undefined}
              >
                <input
                  type="checkbox"
                  aria-label={choice.file.display_name}
                  checked={choice.selected}
                  disabled={busy}
                  onChange={(event) =>
                    onFilesChange(
                      files.map((item) =>
                        item === choice
                          ? { ...item, selected: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <AttachmentThumbnail file={choice.file} size="row" />
                <span className="attachment-choice-text">
                  <span className="attachment-choice-name">
                    {choice.file.display_name}
                  </span>
                  <small>Google Drive · Linked to the current file</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
