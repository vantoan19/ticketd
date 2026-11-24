import { expect, test } from "vitest";
import { syncRecoveries } from "@/lib/sync-api";
import { recoveryCopy } from "./sync-recovery";
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
