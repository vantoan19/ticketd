import { formatSize } from "@/features/attachments/format-size";
import { describeFailure } from "@/lib/api/describe-failure";

/** Captured bytes sent to the host with the message, in draft order. */
export interface ChatAttachmentInput {
  name: string;
  dataUrl: string;
}

type Capture = (file: File) => Promise<ChatAttachmentInput>;
export class CaptureError extends Error {}
type ItemIdentity = { id: number; name: string };
type Item = ItemIdentity &
  (
    | { state: "capturing" }
    | { state: "failed"; error: string; source: File | null }
    | { state: "ready"; content: ChatAttachmentInput }
  );

/** The Chat keeps this draft even when the composer unmounts. */
export class ComposerAttachments {
  private items: Item[] = [];
  private nextId = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly capture: Capture) {}

  snapshot = () => this.items;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(items: Item[]) {
    this.items = items;
    for (const listener of this.listeners) listener();
  }

  add(files: readonly File[]) {
    if (!files.length) return;
    const pending = files.map((file) => ({
      file,
      item: {
        id: this.nextId++,
        name: file.name || "Screenshot",
        state: "capturing" as const,
      },
    }));
    this.update([...this.items, ...pending.map(({ item }) => item)]);
    for (const { file, item } of pending) void this.captureItem(item, file);
  }

  addCaptured(files: readonly ChatAttachmentInput[]) {
    this.update([
      ...this.items,
      ...files.map((content) => ({
        id: this.nextId++,
        name: content.name,
        state: "ready" as const,
        content,
      })),
    ]);
  }

  addClipboardImage(capture: Promise<ChatAttachmentInput | null>) {
    const failed = this.items.find(
      (item) => item.state === "failed" && item.source === null,
    );
    const item = { id: failed?.id ?? this.nextId++, name: "Screenshot.png" };
    const pending = { ...item, state: "capturing" as const };
    if (failed) this.replace(pending);
    else this.update([...this.items, pending]);
    void capture.then(
      (content) => {
        if (content)
          this.replace({
            ...item,
            name: content.name,
            state: "ready",
            content,
          });
        else if (failed) this.replace(failed);
        else this.remove(new Set([item.id]));
      },
      (reason: unknown) => this.fail(item, reason, null),
    );
  }

  retry(id: number) {
    const item = this.items.find((item) => item.id === id);
    if (item?.state !== "failed" || !item.source) return;
    const base = { id: item.id, name: item.name };
    this.replace({ ...base, state: "capturing" });
    void this.captureItem(base, item.source);
  }

  private async captureItem(base: ItemIdentity, file: File) {
    try {
      const content = await this.capture(file);
      this.replace({
        id: base.id,
        name: content.name,
        state: "ready",
        content,
      });
    } catch (reason: unknown) {
      this.fail(base, reason, file);
    }
  }

  private fail(base: ItemIdentity, reason: unknown, source: File | null) {
    const failure = describeFailure(reason, "capture the attachment", {
      readable: reason instanceof CaptureError,
    });
    this.replace({
      ...base,
      state: "failed",
      error: `${failure.title}. ${failure.sentence}`,
      source,
    });
  }

  private replace(item: Item) {
    this.update(this.items.map((old) => (old.id === item.id ? item : old)));
  }

  remove(ids: Set<number>) {
    this.update(this.items.filter((item) => !ids.has(item.id)));
  }
}

export const NO_ATTACHMENTS = new ComposerAttachments(() =>
  Promise.reject(new Error("Attachment capture is unavailable.")),
);
export async function captureChatAttachment(
  file: File,
  limit: number,
  validate?: (input: ChatAttachmentInput) => Promise<string>,
): Promise<ChatAttachmentInput> {
  if (file.size > limit)
    throw new CaptureError(
      `File exceeds the workspace upload limit of ${formatSize(limit)}.`,
    );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const unreadable = () =>
      reject(new CaptureError("Could not read the file."));
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : unreadable();
    reader.onerror = unreadable;
    reader.onabort = () =>
      reject(new CaptureError("File capture was canceled."));
    reader.readAsDataURL(file);
  });
  const name = file.name || `Screenshot.${file.type.slice(6)}`;
  if (validate) {
    const media = await validate({ name, dataUrl });
    return {
      name,
      dataUrl: `data:${media}${dataUrl.slice(dataUrl.indexOf(";base64,"))}`,
    };
  }

  // Browser fixtures mirror the native validation for files they capture.
  if (name === "." || name === ".." || /[/\\:\0]/.test(name))
    throw new CaptureError("The attachment has an invalid file name.");
  const match = /^data:([^,]{0,128});base64,/.exec(dataUrl);
  if (!match) throw new CaptureError("The attachment could not be read.");
  const claimed = match[1]?.split(";")[0] ?? "";
  const header = atob(dataUrl.slice(match[0].length, match[0].length + 24));
  let image: string | undefined;
  if (header.startsWith("\x89PNG\r\n\x1a\n") && header.slice(12, 16) === "IHDR")
    image = "image/png";
  else if (header.startsWith("\xff\xd8\xff")) image = "image/jpeg";
  else if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    image = "image/gif";
  else if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
    image = "image/webp";
  if (claimed.startsWith("image/") && image !== claimed)
    throw new CaptureError(
      "The file bytes do not match a supported PNG, JPEG, WebP, or GIF image.",
    );
  return {
    name,
    dataUrl: `data:${image ?? (claimed || "application/octet-stream")};base64,${dataUrl.slice(match[0].length)}`,
  };
}
