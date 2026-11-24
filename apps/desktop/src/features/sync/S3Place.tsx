import { useEffect, useState } from "react";
import { Check, Cloud, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import { useCopy } from "@/components/ui/use-copy";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { s3Api, type S3FolderLinks } from "@/lib/s3-api";
import { syncApi, type SyncStatus } from "@/lib/sync-api";
import { SyncFailure as Failure } from "./SyncFailure";
import "@/features/settings/settings.css";
import "./sync.css";

/**
 * Where a connected Workspace lives in S3: who this desktop signs in as, the
 * bucket and prefix, and one way to look at the folder, the AWS console where
 * the bucket is on AWS and its `s3://` address for any other S3 service.
 */
export function S3Place({ status }: { status: SyncStatus }) {
  const [links, setLinks] = useState<S3FolderLinks | null | undefined>(
    undefined,
  );
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const { copied, error, copy } = useCopy();
  const s3 = status.s3;
  const folder = status.folder?.name;
  const hasFolder = status.folder !== null;
  useEffect(() => {
    if (!hasFolder) return;
    let current = true;
    s3Api
      .folderLinks()
      .then((read) => {
        if (current) setLinks(read);
      })
      .catch(() => {
        // The address is still in the row; only the shortcut is missing.
        if (current) setLinks(null);
      });
    return () => {
      current = false;
    };
    // The folder and bucket do not change while connected.
  }, [hasFolder]);
  return (
    <div className="sync-block">
      <SettingsList>
        <SettingsRow
          leading={
            <SettingsRowTile>
              <Cloud size={20} />
            </SettingsRowTile>
          }
          title={
            // A profile that reaches another service stopped sync; the notice above says so.
            status.recovery === "service_changed" ? (
              <StatusLabel tone="attention">Not syncing</StatusLabel>
            ) : (
              <StatusLabel tone="positive">Connected</StatusLabel>
            )
          }
          description={
            <>
              {status.account && (
                <span className="block wrap-anywhere">{status.account}</span>
              )}
              {s3 && (
                <span className="block wrap-anywhere">
                  {folder ? `“${folder}” in ` : ""}s3://{s3.bucket}/{s3.prefix}{" "}
                  · profile {s3.profile}
                </span>
              )}
            </>
          }
          trailing={
            links === undefined && hasFolder ? (
              <Skeleton className="h-8 w-40" />
            ) : links?.console ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFailure(null);
                  syncApi
                    .openFolder()
                    .catch((reason: unknown) =>
                      setFailure(
                        describeFailure(reason, "open the AWS console"),
                      ),
                    );
                }}
              >
                Open in AWS console
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : links ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copy("address", links.address)}
              >
                Copy s3:// address
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </Button>
            ) : null
          }
        />
        <SettingsListFooter>
          ticketd does not encrypt the files it puts in the bucket, and sync
          never deletes them.
        </SettingsListFooter>
      </SettingsList>
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
      {error && <p className="settings-hint">{error}</p>}
      <Failure>{failure}</Failure>
    </div>
  );
}
