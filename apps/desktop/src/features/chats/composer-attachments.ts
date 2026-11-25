import { formatSize } from "@/features/attachments/format-size";
import { describeFailure } from "@/lib/api/describe-failure";

export interface ChatImage {
  name: string;
  dataUrl: string;
}

type Capture = (file: File) => Promise<ChatImage>;
class ClipboardImageError extends Error {}
type Item = { id: number; name: string } & (
  | { state: "capturing" }
  | { state: "failed"; error: string }
  | { state: "ready"; image: ChatImage }
);

/** An existing Chat keeps this draft even when the composer unmounts. */
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

  async paste(file: File) {
    const base = { id: this.nextId++, name: file.name || "Screenshot" };
    this.update([...this.items, { ...base, state: "capturing" }]);
    let item: Item;
    try {
      item = { ...base, state: "ready", image: await this.capture(file) };
    } catch (reason: unknown) {
      const failure = describeFailure(reason, "capture the image", {
        readable: reason instanceof ClipboardImageError,
      });
      item = {
        ...base,
        state: "failed",
        error: `${failure.title}. ${failure.sentence}`,
      };
    }
    this.update(this.items.map((old) => (old.id === base.id ? item : old)));
  }

  remove(ids: Set<number>) {
    this.update(this.items.filter((item) => !ids.has(item.id)));
  }
}

export const NO_ATTACHMENTS = new ComposerAttachments(() =>
  Promise.reject(new Error("Image capture is unavailable.")),
);
export async function captureClipboardImage(
  file: File,
  limit: number,
): Promise<ChatImage> {
  if (file.size > limit)
    throw new ClipboardImageError(
      `Image exceeds the workspace upload limit of ${formatSize(limit)}.`,
    );
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new ClipboardImageError(
      "Chat can attach PNG, JPEG, WebP, and GIF images.",
    );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else
        reject(new ClipboardImageError("Could not read the clipboard image."));
    };
    reader.onerror = () =>
      reject(new ClipboardImageError("Could not read the clipboard image."));
    reader.onabort = () =>
      reject(new ClipboardImageError("Clipboard image capture was canceled."));
    reader.readAsDataURL(file);
  });
  return { name: file.name || `Screenshot.${file.type.slice(6)}`, dataUrl };
}
