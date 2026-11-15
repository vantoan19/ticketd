import type { Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

/** One file chosen in Google Drive, and the identity its insertion keeps. */
export type DriveChoice = {
  file: Attachment;
  requestId: string;
  selected: boolean;
  /** Set after a failure: insert before this later file on retry. */
  beforeId?: string;
};

/**
 * Adds the selected Drive files in order. A failed file keeps its identity and
 * retries before the first later success. Returns the files still to add.
 */
export async function addDriveFiles(
  files: DriveChoice[],
  onPick: (
    file: Attachment,
    requestId: string,
    beforeId?: string,
  ) => Promise<void>,
  live: () => boolean,
): Promise<{ left: DriveChoice[]; failure: FailureDescription | null }> {
  let left = [...files];
  const failed: DriveChoice[] = [];
  const failures: string[] = [];
  for (const selected of files.filter((item) => item.selected)) {
    if (!live()) break;
    try {
      if (selected.beforeId)
        await onPick(selected.file, selected.requestId, selected.beforeId);
      else await onPick(selected.file, selected.requestId);
      // A failed earlier file retries before the first later success.
      for (const item of failed) item.beforeId ??= selected.file.id;
      left = left.filter((item) => item.requestId !== selected.requestId);
    } catch (reason) {
      failed.push({ ...selected });
      failures.push(
        `${selected.file.display_name}: ${describeFailure(reason, "add").details}`,
      );
    }
  }
  left = left.map(
    (item) =>
      failed.find((failure) => failure.requestId === item.requestId) ?? item,
  );
  return {
    left,
    failure: failures.length
      ? {
          code: "failed",
          title: `Couldn't add ${failures.length} ${failures.length === 1 ? "file" : "files"}`,
          sentence:
            "Nothing changed in Drive. Add them again, or reuse them from Existing files.",
          action: null,
          details: failures.join("\n"),
        }
      : null,
  };
}
