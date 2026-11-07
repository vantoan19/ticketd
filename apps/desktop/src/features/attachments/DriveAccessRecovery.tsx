import { useEffect, useRef, useState } from "react";
import { File } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  attachments,
  type DriveAccess,
  type DriveConfiguration,
} from "@/lib/api/attachments";
import { DriveSetupNotice } from "./DriveSetupNotice";

const headings = {
  unconfigured: "Google Drive setup is required",
  reauthorize: "Reconnect to Google Drive",
  select_file: "Allow ticketd to access this file",
  permission_denied: "Drive permission denied",
  missing: "This file is in Drive trash",
  inaccessible_or_missing: "Access or availability is uncertain",
  offline: "Google Drive is unavailable",
  rate_limited: "Google Drive is rate limited",
  unsupported: "This Drive content is unsupported",
  invalid_response: "Drive access could not be verified",
  cancelled: "Drive selection cancelled",
  uncertain: "Drive access could not be verified",
} as const;

export function DriveAccessRecovery({
  id,
  onRefresh,
}: {
  id: string;
  onRefresh: () => void;
}) {
  const [access, setAccess] = useState<DriveAccess | null>(null);
  const [configuration, setConfiguration] = useState<DriveConfiguration | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const operation = useRef<string | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    void attachments
      .checkDriveReference(id)
      .then((value) => {
        if (generation.current === current) {
          setAccess(value);
          if (!value.failure) onRefresh();
        }
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setError(String(reason));
      });
    void attachments
      .driveConfiguration()
      .then((value) => {
        if (generation.current === current) setConfiguration(value);
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setError(String(reason));
      });
    return () => {
      generation.current += 1;
      if (operation.current)
        void attachments
          .cancelDriveSelection(operation.current)
          .catch(() => {});
      operation.current = null;
    };
  }, [id, onRefresh]);

  async function check(recover: boolean) {
    const current = generation.current;
    setBusy(true);
    setSelecting(recover);
    setError("");
    const operationId = recover ? crypto.randomUUID() : null;
    operation.current = operationId;
    try {
      const result = operationId
        ? await attachments.recoverDriveReference(id, operationId)
        : await attachments.checkDriveReference(id);
      if (generation.current !== current) return;
      setAccess(result);
      if (!result.failure) onRefresh();
    } catch (reason) {
      if (generation.current === current) setError(String(reason));
    } finally {
      if (generation.current === current) {
        operation.current = null;
        setBusy(false);
        setSelecting(false);
      }
    }
  }

  const kind = access?.failure?.kind;
  return (
    <div className="attachment-preview-fallback" aria-busy={busy}>
      <File aria-hidden="true" />
      <h3>
        {kind
          ? headings[kind]
          : access
            ? "Current source in Google Drive"
            : "Checking Drive access…"}
      </h3>
      <p role="status">
        {access?.failure?.message ??
          "Current source content · No local snapshot. Open this file in Drive; its content can change independently. Remote bytes are not cached automatically."}
      </p>
      {(kind === "permission_denied" || kind === "inaccessible_or_missing") && (
        <p>
          Open in Drive and request access from its owner, then retry. ticketd
          does not change sharing.
        </p>
      )}
      {kind === "select_file" && (
        <p>
          Account access and ticketd authorization are separate. Select only
          this original file in the Drive Picker.
        </p>
      )}
      {(kind === "reauthorize" ||
        kind === "select_file" ||
        kind === "inaccessible_or_missing") && (
        <Button
          disabled={busy || !configuration?.configured}
          onClick={() => void check(true)}
        >
          {kind === "reauthorize" ? "Reconnect" : "Authorize file"}
        </Button>
      )}
      {configuration && <DriveSetupNotice configuration={configuration} />}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void check(false)}
      >
        {kind ? "Retry" : "Refresh details"}
      </Button>
      {selecting && (
        <Button
          variant="ghost"
          onClick={() => {
            const currentGeneration = generation.current;
            const operationId = operation.current;
            if (operationId)
              void attachments
                .cancelDriveSelection(operationId)
                .catch((reason: unknown) => {
                  if (generation.current === currentGeneration)
                    setError(String(reason));
                });
          }}
        >
          Cancel selection
        </Button>
      )}
      <small className="attachment-hint">
        Last-known details and authored references are preserved.
      </small>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
