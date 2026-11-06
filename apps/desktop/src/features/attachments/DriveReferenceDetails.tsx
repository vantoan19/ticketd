import { useEffect, useState } from "react";
import { attachments, type DriveReference } from "@/lib/api/attachments";
import { formatSize } from "./format-size";

const nativeTypes: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Docs",
  "application/vnd.google-apps.spreadsheet": "Google Sheets",
  "application/vnd.google-apps.presentation": "Google Slides",
};

/** Read last-known details only; opening this dialog does not require connectivity. */
export function DriveReferenceDetails({ id }: { id: string }) {
  const [reference, setReference] = useState<DriveReference | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void attachments
      .driveInfo(id)
      .then((value) => {
        if (current) setReference(value);
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [id]);
  if (!reference)
    return (
      <>
        <dt>Drive details</dt>
        <dd>{error || "Loading last-known details…"}</dd>
      </>
    );
  return (
    <>
      <dt>Type</dt>
      <dd>
        {nativeTypes[reference.metadata.mime_type] ??
          reference.metadata.mime_type}
      </dd>
      <dt>Size</dt>
      <dd>{formatSize(reference.metadata.size_bytes)}</dd>
      <dt>Storage</dt>
      <dd>Google Drive · External reference</dd>
    </>
  );
}
