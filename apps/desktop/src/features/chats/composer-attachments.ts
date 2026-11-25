import { formatSize } from "@/features/attachments/format-size";
import { describeFailure } from "@/lib/api/describe-failure";

/** Captured bytes sent to the host with the message, in draft order. */
export interface ChatAttachmentInput {
  name: string;
  dataUrl: string;
}

type Capture = (file: File) => Promise<ChatAttachmentInput>;
class CaptureError extends Error {}
type ItemIdentity = { id: number; name: string };
type Item = ItemIdentity &
  (
    | { state: "capturing" }
    | { state: "failed"; error: string; source: File }
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

  retry(id: number) {
    const item = this.items.find((item) => item.id === id);
    if (item?.state !== "failed") return;
    const base = { id: item.id, name: item.name };
    this.replace({ ...base, state: "capturing" });
    void this.captureItem(base, item.source);
  }

  private async captureItem(base: ItemIdentity, file: File) {
    let item: Item;
    try {
      const content = await this.capture(file);
      item = { id: base.id, name: content.name, state: "ready", content };
    } catch (reason: unknown) {
      const failure = describeFailure(reason, "capture the attachment", {
        readable: reason instanceof CaptureError,
      });
      item = {
        id: base.id,
        name: base.name,
        state: "failed",
        error: `${failure.title}. ${failure.sentence}`,
        source: file,
      };
    }
    this.replace(item);
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
): Promise<ChatAttachmentInput> {
  if (
    file.name === "." ||
    file.name === ".." ||
    ["/", "\\", ":"].some((character) => file.name.includes(character))
  )
    throw new CaptureError("The attachment has an invalid file name.");
  if (file.size > limit)
    throw new CaptureError(
      `File exceeds the workspace upload limit of ${formatSize(limit)}.`,
    );
  if (
    file.type.startsWith("image/") &&
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new CaptureError("Chat can attach PNG, JPEG, WebP, and GIF images.");
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
  return { name: file.name || `Screenshot.${file.type.slice(6)}`, dataUrl };
}
