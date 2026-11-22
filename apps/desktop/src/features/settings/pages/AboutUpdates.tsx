import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { updateClient } from "@/features/updates/client";
import {
  initialUpdateState,
  useUpdates,
} from "@/features/updates/update-state";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";
import { APP_VERSION } from "@/lib/app-version";
import { relativeDateTime } from "@/lib/format";

export function AboutUpdates() {
  const updates = useUpdates();
  const state = updates?.snapshot ?? initialUpdateState;
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const switchId = useId();
  const descriptionId = useId();

  async function act(what: string, run: () => Promise<unknown>) {
    setFailure(null);
    try {
      await run();
    } catch (reason) {
      setFailure(describeFailure(reason, what));
    }
  }

  let title = `ticketd ${APP_VERSION}`;
  let description = state.automatic
    ? "ticketd checks for updates once a day."
    : "ticketd only checks when you ask.";
  let checkLabel = "Check for updates";
  let checking = false;
  let releaseLink: { label: string; url: string } | undefined;
  switch (state.status) {
    case "unavailable":
      description = "This build can’t update itself.";
      break;
    case "checking":
      description = "Checking for updates…";
      checkLabel = "Checking…";
      checking = true;
      break;
    case "downloading":
      description = `Downloading and checking ticketd ${state.update.version}…`;
      checkLabel = "Downloading…";
      checking = true;
      break;
    case "up_to_date":
      title += " is up to date";
      description = `Checked ${relativeDateTime(new Date(state.checked_at * 1000).toISOString())}`;
      break;
    case "check_failed":
      title = "Couldn’t check for updates";
      description = state.automatic
        ? "GitHub didn’t answer. ticketd tries again tomorrow."
        : "GitHub didn’t answer.";
      checkLabel = "Try again";
      break;
    case "download_failed":
      title = `Couldn’t update to ticketd ${state.update.version}`;
      description = state.error;
      checkLabel = "Try again";
      releaseLink = { label: "Download", url: state.update.release_url };
      break;
    case "manual_install":
      title = `ticketd ${state.update.version} is available`;
      description = "Download the .deb to update ticketd.";
      releaseLink = { label: "Download .deb", url: state.update.release_url };
      break;
    case "ready":
      title = `ticketd ${state.update.version} is ready`;
      description =
        state.install_on_quit && !state.update.upgrades_workspace
          ? "Downloaded and checked. It installs when ticketd restarts."
          : "Downloaded and checked. It installs when you choose Restart to update.";
      releaseLink = { label: "What’s new", url: state.update.release_url };
      break;
  }

  const release = releaseLink;
  return (
    <SettingsSection title="Updates">
      <SettingsList>
        <SettingsRow
          title={
            <span className="flex items-center gap-2" role="status">
              {state.status === "ready" && <StatusDot tone="unread" />}
              {title}
            </span>
          }
          description={description}
          trailing={
            <>
              {release && (
                <Button
                  variant={
                    state.status === "manual_install" ? "outline" : "ghost"
                  }
                  size="sm"
                  asChild
                >
                  <a
                    href={release.url}
                    onClick={(event) => {
                      event.preventDefault();
                      void act("open the release", () =>
                        workspaceClient.openLink(release.url),
                      );
                    }}
                  >
                    {release.label}
                  </a>
                </Button>
              )}
              {state.status === "ready" ? (
                <Button
                  size="sm"
                  onClick={() => updates?.openRestart(state.update)}
                >
                  Restart to update
                </Button>
              ) : (
                state.status !== "manual_install" &&
                state.status !== "unavailable" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checking}
                    onClick={() =>
                      void act("check for updates", updateClient.check)
                    }
                  >
                    {checkLabel}
                  </Button>
                )
              )}
            </>
          }
        />
        {state.status !== "unavailable" && (
          <SettingsRow
            title={
              <label htmlFor={switchId}>Check for updates automatically</label>
            }
            description="Once a day, ticketd asks GitHub for the newest release. Nothing about you or your workspace is sent."
            descriptionId={descriptionId}
            trailing={
              <Switch
                id={switchId}
                aria-describedby={descriptionId}
                checked={state.automatic}
                disabled={saving}
                onCheckedChange={async (enabled) => {
                  if (!updates) return;
                  setSaving(true);
                  await act("save automatic update checks", () =>
                    updates.setAutomatic(enabled),
                  );
                  setSaving(false);
                }}
              />
            }
          />
        )}
      </SettingsList>
      {failure && <FailureAlert size="compact" failure={failure} />}
    </SettingsSection>
  );
}
