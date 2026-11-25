import { z } from "zod";
import {
  CaptureError,
  type ChatAttachmentInput,
} from "@/features/chats/composer-attachments";

const imageEvent = "ticketd-clipboard-image";
const imagePickerType = "application/x-ticketd-clipboard-image-";
const reply = z.object({
  id: z.string(),
  attachment: z.object({ name: z.string(), dataUrl: z.string() }).optional(),
  error: z.string().optional(),
});

export function redactedLinuxPaste(clipboard: DataTransfer) {
  return (
    clipboard.types.length === 0 &&
    clipboard.files.length === 0 &&
    (clipboard.items?.length ?? 0) === 0
  );
}

/** The app-scoped native chooser sends bytes only for this trusted paste. */
export function readLinuxClipboardImage(picker: HTMLInputElement) {
  return new Promise<ChatAttachmentInput | null>((resolve, reject) => {
    const id = crypto.randomUUID();
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const result = reply.safeParse(event.detail);
      if (!result.success || result.data.id !== id) return;
      cleanUp();
      if (result.data.error) reject(new CaptureError(result.data.error));
      else resolve(result.data.attachment ?? null);
    };
    const cleanUp = () => {
      window.clearTimeout(expires);
      window.removeEventListener(imageEvent, receive);
    };
    const expires = window.setTimeout(() => {
      cleanUp();
      resolve(null);
    }, 10_000);
    window.addEventListener(imageEvent, receive);
    picker.accept = imagePickerType + id;
    try {
      picker.showPicker();
    } catch {
      cleanUp();
      resolve(null);
    }
  });
}
