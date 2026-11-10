import { z } from "zod";
import {
  attachmentUploadDestinationSchema,
  attachmentSchema,
  attachments,
  driveDestinationSchema,
} from "@/lib/api/attachments";

const recordSchema = z.object({
  requestId: z.string(),
  linkRequestId: z.string(),
  name: z.string(),
  order: z.number(),
  source: z.union([z.string(), z.instanceof(File)]),
  intent: attachmentUploadDestinationSchema.optional(),
  stored: attachmentSchema.optional(),
  destination: driveDestinationSchema.optional(),
  destinationName: z.string().optional(),
});
export type UploadRecord = z.infer<typeof recordSchema>;

// Capture recovery is browser-local; canonical attachment bytes and replay outcomes
// remain core-owned. Nothing here is a saved content reference or retention lease.
export class UploadRecovery {
  private constructor(
    private database: IDBDatabase,
    private workspaceId: string,
  ) {}

  static async open() {
    const workspaceId = await attachments.workspaceId();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ticketd-upload-recovery", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("uploads", {
          keyPath: "requestId",
        });
        store.createIndex("workspace", "workspaceId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new Error("Close other ticketd windows to open upload recovery"),
        );
    });
    return new UploadRecovery(database, workspaceId);
  }

  async list(): Promise<UploadRecord[]> {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction("uploads", "readonly");
      const request = tx
        .objectStore("uploads")
        .index("workspace")
        .getAll(this.workspaceId);
      tx.oncomplete = () => {
        const parsed = z.array(recordSchema).safeParse(request.result);
        if (parsed.success)
          resolve(parsed.data.sort((a, b) => a.order - b.order));
        else
          reject(
            new Error(
              "Upload recovery is unreadable; completed snapshots remain in Existing files",
            ),
          );
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async put(record: UploadRecord): Promise<void> {
    // Do not clone live progress state, callback functions or AbortControllers.
    const value = recordSchema.parse(record);
    return this.write((store) => {
      store.put({ ...value, workspaceId: this.workspaceId });
    });
  }

  async remove(requestId: string): Promise<void> {
    return this.write((store) => {
      store.delete(requestId);
    });
  }

  private async write(change: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction("uploads", "readwrite", {
        durability: "strict",
      });
      change(tx.objectStore("uploads"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  close() {
    this.database.close();
  }
}
