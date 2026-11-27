import { attachments, type PreviewInfo } from "@/lib/api/attachments";

const reading = new Map<string, Promise<PreviewInfo>>();
let identifying: Promise<string> | null = null;

/** The Workspace id, as a card needs it: every card of a list asks at once, and one read answers all. */
export function cardWorkspace() {
  identifying ??= attachments.workspaceId().finally(() => {
    identifying = null;
  });
  return identifying;
}

/**
 * A card's read of a file's preview facts. A card asks twice at once (for its still
 * and for the Missing caption), and they share one read: the second asker gets the
 * answer already on its way. Nothing is kept, so a later ask reads again.
 */
export function readCardPreview(workspace: string, id: string) {
  const key = `${workspace}/${id}`;
  let read = reading.get(key);
  if (!read) {
    read = attachments.preview(workspace, id).finally(() => {
      reading.delete(key);
    });
    reading.set(key, read);
  }
  return read;
}
