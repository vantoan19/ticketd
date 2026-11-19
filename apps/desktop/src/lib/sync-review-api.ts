import { z } from "zod";
import { invoke, structured } from "@/lib/api/bridge-failure";

/**
 * The bridge contract for reviewing what sync did: conflicts that need a
 * decision, notices that need none, version History, and whether a managed
 * Attachment's bytes are on this desktop. Timestamps are ISO 8601 strings and
 * record ids are GUIDs. Field values are display-ready text; `body` carries
 * Markdown source.
 */

/** Every synced record kind can conflict; only tickets and Documents keep History. */
const recordKindSchema = z.enum([
  "ticket",
  "document",
  "plan",
  "project",
  "automation_agent",
  "automation",
]);
export type RecordKind = z.infer<typeof recordKindSchema>;
export type VersionedKind = "ticket" | "document";
export type RecordKey = { kind: RecordKind; id: string };

const conflictSummarySchema = z.object({
  kind: recordKindSchema,
  id: z.string(),
  /** The Ticket reference; null for every other kind. */
  reference: z.string().nullable(),
  title: z.string(),
  /** Keys of the fields changed on two desktops, such as `status` and `body`. */
  fields: z.array(z.string()),
  detected_at: z.string(),
  /** Local Inbox read state of the conflict's entry. */
  read: z.boolean(),
});
export type ConflictSummary = z.infer<typeof conflictSummarySchema>;

const conflictSchema = conflictSummarySchema.extend({
  /** This desktop's name. */
  local_device: z.string(),
  fields: z.array(
    z.object({
      /** The key a choice is sent back under. */
      field: z.string(),
      /** The Activity or Implementation evidence the field is inside, if any. */
      section: z
        .object({
          kind: z.enum(["activity", "evidence"]),
          /** When the Activity was reported. */
          reported_at: z.string().nullable(),
          /** What the Implementation evidence is named. */
          name: z.string().nullable(),
        })
        .nullable(),
      local: z.string(),
      /** When this desktop last changed the field; null when nothing recorded it. */
      local_changed_at: z.string().nullable(),
      remote: z.string(),
      /** When Drive received the other value; null when Drive could not say. */
      remote_changed_at: z.string().nullable(),
      /** Name of the desktop the other value came from. */
      remote_device: z.string(),
      /** Names the other value shown; a choice is sent back with it. */
      detected_at: z.string(),
    }),
  ),
});
export type Conflict = z.infer<typeof conflictSchema>;
export type ConflictField = Conflict["fields"][number];

/**
 * `edited` carries the person's own text in `value`; only `body` accepts it.
 * `detected_at` is the field's, as shown: a choice made on a value that has
 * changed since is refused with `review_changed`.
 */
export type Resolution = { field: string; detected_at: string } & (
  { choice: "local" | "remote" } | { choice: "edited"; value: string }
);

const noticeBase = { id: z.string(), timestamp: z.string(), read: z.boolean() };
const fileNotice = {
  ...noticeBase,
  /** Path inside the sync folder, such as `tickets/T-MW21.md`. */
  path: z.string(),
  /** Why, in words for the person: "unknown field 'priority' in a ticket". */
  reason: z.string(),
  /** The Ticket the file belongs to, while it is in this Workspace. */
  ticket_reference: z.string().optional(),
};
const noticeSchema = z.discriminatedUnion("kind", [
  /** Sync dropped a dependency edge that would have made a loop. */
  z.object({
    ...noticeBase,
    kind: z.literal("dependency_removed"),
    /** The ticket the notice is about, and how it related to `other`. */
    reference: z.string(),
    title: z.string(),
    relation: z.enum(["blocks", "blocked_by"]),
    other: z.string(),
  }),
  /** Sync dropped a parent link that would have made a loop. */
  z.object({
    ...noticeBase,
    kind: z.literal("parent_removed"),
    /** The child ticket, and the Ticket reference of the parent it lost. */
    reference: z.string(),
    title: z.string(),
    other: z.string(),
  }),
  /** A file in Drive could not be read and was skipped. */
  z.object({ ...fileNotice, kind: z.literal("unreadable_file") }),
  /** Such a file was then replaced by this desktop's version of the record. */
  z.object({ ...fileNotice, kind: z.literal("replaced_file") }),
  /** A record of this desktop is too large to upload. */
  z.object({ ...fileNotice, kind: z.literal("oversized_record") }),
]);
export type Notice = z.infer<typeof noticeSchema>;

/** `drive` versions are Drive's own file revisions, fetched only when asked for. */
export type VersionSource = "local" | "drive";

const versionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  /** Name of the other desktop that made the change; null for this desktop, Drive or `oldest`. */
  device: z.string().nullable(),
  /** Keys of the fields in which this version differs from the current one; Drive's are not known. */
  changed: z.array(z.string()),
  /** The oldest version kept on this desktop: where it came from was not recorded. */
  oldest: z.boolean().optional(),
});
export type Version = z.infer<typeof versionSchema>;

const versionDetailSchema = z.object({
  /** Only the fields whose value differs from the current version. */
  fields: z.array(
    z.object({ field: z.string(), value: z.string(), current: z.string() }),
  ),
});
export type VersionDetail = z.infer<typeof versionDetailSchema>;

const availabilitySchema = z.object({
  id: z.string(),
  state: z.enum(["downloaded", "downloading", "not_downloaded"]),
  /** Percent downloaded while `downloading`, when known. */
  progress: z.number().nullable(),
});
export type Availability = z.infer<typeof availabilitySchema>;

type VersionKey = { kind: VersionedKind; id: string; source: VersionSource };

/** Keeps the entries this build understands, so a newer core's kinds do not empty the list. */
function known<T>(schema: z.ZodType<T>, value: unknown): T[] {
  return z
    .array(z.unknown())
    .parse(value)
    .flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
}

export const syncReview = {
  /** Every record that Needs review. */
  async conflicts(): Promise<ConflictSummary[]> {
    return known(
      conflictSummarySchema,
      await structured(invoke("sync_conflicts")),
    );
  },
  async conflict(key: RecordKey): Promise<Conflict> {
    return conflictSchema.parse(await structured(invoke("sync_conflict", key)));
  },
  /** Settles every conflicting field of the record; it then syncs as a normal edit. */
  async resolve(
    key: RecordKey,
    resolutions: Resolution[],
    /** The same id for the same resolutions, so a repeat is applied once. */
    requestId: string,
  ): Promise<void> {
    await structured(
      invoke("resolve_sync_conflict", { ...key, resolutions, requestId }),
    );
  },
  /** Things sync did that need no decision, newest first. */
  async notices(): Promise<Notice[]> {
    return known(noticeSchema, await structured(invoke("sync_notices")));
  },
  /** Marks Inbox entries read; an id is a notice id or a conflicting record's id. */
  async setRead(ids: string[], read: boolean): Promise<void> {
    await structured(invoke("set_sync_read", { ids, read }));
  },
  /** Earlier versions, newest first; never includes the current one. */
  async versions(key: VersionKey): Promise<Version[]> {
    return z
      .array(versionSchema)
      .parse(await structured(invoke("record_versions", key)));
  },
  async version(key: VersionKey, version: string): Promise<VersionDetail> {
    return versionDetailSchema.parse(
      await structured(invoke("record_version", { ...key, version })),
    );
  },
  /** Writes the version's content as a normal new edit. */
  async restore(
    key: VersionKey,
    version: string,
    /** The same id for the same version, so a repeat is applied once. */
    requestId: string,
  ): Promise<void> {
    await structured(
      invoke("restore_record_version", { ...key, version, requestId }),
    );
  },
  /** Availability of the named managed Attachments; ids it does not know are left out. */
  async availability(ids: string[]): Promise<Availability[]> {
    return known(
      availabilitySchema,
      await structured(invoke("attachment_availability", { ids })),
    );
  },
  /** Starts downloading the file's bytes; progress shows through `availability`. */
  async download(id: string): Promise<void> {
    await structured(invoke("download_attachment", { id }));
  },
};
