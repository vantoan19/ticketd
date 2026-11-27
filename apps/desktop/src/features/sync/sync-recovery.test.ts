import { describe, expect, test } from "vitest";
import { syncRecoveries, type SyncStatus } from "@/lib/sync-api";
import { recoveryCopy, statusRow } from "./sync-recovery";
import { syncStatus } from "./sync-fixtures";

const s3 = (recovery: (typeof syncRecoveries)[number]) =>
  syncStatus({
    provider: "s3",
    recovery,
    recovery_message: "the bucket answered 500",
  });

test("no recovery message of an S3 binding says Drive, and each names the storage it concerns", () => {
  for (const recovery of syncRecoveries) {
    const copy = recoveryCopy(s3(recovery));
    expect(copy, recovery).not.toBeNull();
    const words = Object.values(copy!).join(" | ");
    expect(words, recovery).not.toMatch(/drive|google/i);
  }
  expect(recoveryCopy(s3("folder_missing"))?.title).toBe(
    "Sync folder not found in S3",
  );
  expect(recoveryCopy(s3("authorization_expired"))).toMatchObject({
    label: "AWS sign-in expired",
    title: "Sign in to AWS again",
    action: "Sign in",
  });
  expect(recoveryCopy(s3("rate_limited"))?.title).toBe("S3 is busy");
  expect(recoveryCopy(s3("storage_full"))?.title).toBe("S3 is full");
});

test("a Google Drive binding keeps saying Google Drive", () => {
  const drive = (recovery: (typeof syncRecoveries)[number]) =>
    recoveryCopy(syncStatus({ recovery }));
  expect(drive("folder_missing")?.title).toBe("Sync folder not found in Drive");
  expect(drive("authorization_expired")?.title).toBe(
    "Sign in to Google Drive again",
  );
  expect(drive("rate_limited")?.title).toBe("Google Drive is busy");
});

test("a changed S3 service says what stopped, shows the message as written and offers Disconnect", () => {
  const copy = recoveryCopy(
    syncStatus({
      provider: "s3",
      recovery: "service_changed",
      recovery_message: "This profile now points to another S3 service.",
    }),
  );
  expect(copy).toMatchObject({
    label: "S3 sync stopped",
    title: "Sync stopped",
    action: "Disconnect",
  });
  expect(copy?.description).toBe(
    "This profile now points to another S3 service. Your work is saved on this computer.",
  );
});

test("a missing aws program says what stopped, shows the message as written and offers to choose it", () => {
  const copy = recoveryCopy(
    syncStatus({
      provider: "s3",
      recovery: "cli_unavailable",
      recovery_message: "The AWS CLI was not found.",
    }),
  );
  expect(copy).toMatchObject({
    label: "AWS CLI needed",
    title: "Sync can't use the AWS CLI",
    action: "Choose the aws program…",
  });
  expect(copy?.description).toBe(
    "The AWS CLI was not found. Your work is saved on this computer.",
  );
});

const NOW = Date.parse("2026-11-27T10:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();
const item = (id: string) => ({
  kind: "ticket" as const,
  id,
  reference: null,
  title: id,
});

describe("the status row of a connected Workspace", () => {
  test("a synced Workspace says when it was checked and which sign-in it uses", () => {
    expect(
      statusRow(
        syncStatus({
          account: "sam.lee@gmail.com",
          last_synced_at: minutesAgo(1),
        }),
        NOW,
      ),
    ).toEqual({
      tone: "positive",
      label: "Synced",
      description: "Checked a minute ago · signed in as sam.lee@gmail.com",
    });
  });

  test("an S3 Workspace names its AWS CLI profile as well", () => {
    const row = statusRow(
      syncStatus({
        provider: "s3",
        account: "arn:aws:iam::1:user/sam",
        s3: {
          bucket: "b",
          prefix: "ticketd/",
          profile: "work",
          aws_cli_path: null,
        },
        last_synced_at: minutesAgo(5),
      }),
      NOW,
    );
    expect(row.description).toBe(
      "Checked 5 minutes ago · profile “work” · signed in as arn:aws:iam::1:user/sam",
    );
  });

  test("work that has not uploaded yet is said, without a problem tone", () => {
    expect(
      statusRow(
        syncStatus({
          state: "upload_pending",
          pending_uploads: [item("a"), item("b")],
        }),
        NOW,
      ),
    ).toMatchObject({ tone: "neutral", label: "Uploading 2 changes…" });
    expect(statusRow(syncStatus({ state: "saved_locally" }), NOW).label).toBe(
      "Saved on this computer",
    );
    expect(
      statusRow(
        syncStatus({
          state: "attachment_download_pending",
          attachment_downloads: { count: 1, bytes_left: 10 },
        }),
        NOW,
      ).label,
    ).toBe("Downloading 1 file…");
  });

  test("records that changed on two computers wait for a review", () => {
    expect(
      statusRow(
        syncStatus({
          state: "needs_attention",
          needs_review: [
            { kind: "ticket", id: "a", reference: "T-KQ1", title: "A" },
          ],
        }),
        NOW,
      ),
    ).toMatchObject({
      tone: "attention",
      label: "Needs review",
      description: "1 record changed on two computers.",
    });
  });

  test("every cause the status line knows is a status of its own with what is kept meanwhile", () => {
    const waiting = [item("a"), item("b"), item("c")];
    const row = (
      recovery: (typeof syncRecoveries)[number],
      extra: Partial<SyncStatus> = {},
    ) =>
      statusRow(
        syncStatus({ recovery, pending_uploads: waiting, ...extra }),
        NOW,
      );
    expect(row("authorization_expired")).toEqual({
      tone: "attention",
      label: "Signed out",
      description:
        "Your Google sign-in ended. 3 changes are saved here and upload after you sign in.",
    });
    expect(
      row("authorization_expired", {
        provider: "s3",
        s3: { bucket: "b", prefix: "p/", profile: "work", aws_cli_path: null },
      }).description,
    ).toBe(
      "The AWS CLI sign-in for profile “work” ended. 3 changes are saved here and upload after you sign in.",
    );
    expect(row("folder_missing")).toMatchObject({
      label: "Folder missing",
      description:
        "“ticketd · web-app” was deleted or moved. Nothing was removed from this computer.",
    });
    expect(row("storage_full")).toMatchObject({
      tone: "attention",
      label: "Storage full",
      description:
        "Google Drive is full. 3 changes are saved here and upload once there is space.",
    });
    expect(row("offline")).toMatchObject({
      tone: "neutral",
      label: "Offline",
      description:
        "ticketd can't reach Google Drive. 3 changes are saved here and upload when you are back online.",
    });
    expect(row("rate_limited")).toMatchObject({
      tone: "neutral",
      label: "Slowed down",
      description:
        "Google Drive asked ticketd to slow down. 3 changes are saved here and upload a little later.",
    });
    expect(
      row("service_changed", { recovery_message: "The profile moved." }),
    ).toMatchObject({
      label: "Not syncing",
      description: "The profile moved. Your work is saved on this computer.",
    });
    expect(
      row("cli_unavailable", {
        recovery_message: "The AWS CLI was not found.",
      }),
    ).toMatchObject({ label: "Not syncing" });
    expect(row("error", { recovery_message: "it broke" })).toMatchObject({
      label: "Not syncing",
      description:
        "Your work is saved on this computer. The last sync stopped with: it broke",
    });
  });

  test("with nothing waiting, a problem still says the work is safe", () => {
    expect(
      statusRow(syncStatus({ recovery: "authorization_expired" }), NOW)
        .description,
    ).toBe("Your Google sign-in ended. Your work is saved on this computer.");
  });

  test("no S3 status says Drive or Google", () => {
    for (const recovery of syncRecoveries) {
      const row = statusRow(
        syncStatus({
          provider: "s3",
          recovery,
          recovery_message: "the bucket answered 500",
          s3: {
            bucket: "b",
            prefix: "p/",
            profile: "work",
            aws_cli_path: null,
          },
        }),
        NOW,
      );
      expect(Object.values(row).join(" | "), recovery).not.toMatch(
        /drive|google/i,
      );
    }
  });
});
