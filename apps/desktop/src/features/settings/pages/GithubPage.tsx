import type { ComponentProps } from "react";
import { CircleDot, UserRound } from "lucide-react";
import { FailureAlert } from "@/components/ui/failure-alert";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status-label";
import { SettingsDrillIn } from "@/features/settings/layout/SettingsDrillIn";
import {
  SettingsList,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { GithubRepositories } from "@/features/settings/sources/GithubRepositories";
import { GithubMark } from "@/features/settings/sources/GithubMark";
import { GithubSignInRow } from "@/features/settings/sources/GithubSignInRow";
import type { GithubIntegration } from "@/lib/api/github";

export function GithubPage({
  integration,
  failure,
  onCheck,
  onBack,
  onChanged,
  projectSetup,
}: {
  integration: GithubIntegration | null;
  failure: FailureDescription | null;
  onCheck: () => void;
  onBack: () => void;
  onChanged: () => void;
  projectSetup?: ComponentProps<typeof GithubRepositories>["projectSetup"];
}) {
  return (
    <SettingsDrillIn
      parent="ticket-sources"
      label="GitHub"
      lede="Your GitHub issues arrive as tickets. Edit them in GitHub."
      icon={CircleDot}
      iconContent={<GithubMark />}
      onBack={onBack}
    >
      {failure && (
        <FailureAlert size="compact" failure={failure} onRetry={onCheck} />
      )}
      <section className="settings-section" aria-label="GitHub sign-in">
        <SettingsList>
          {integration ? (
            integration.hosts.map((host) => (
              <GithubSignInRow
                key={host.host}
                host={host}
                onChanged={onCheck}
                onCheck={onCheck}
              />
            ))
          ) : (
            <SettingsRow
              leading={
                <SettingsRowTile>
                  <UserRound />
                </SettingsRowTile>
              }
              title={<StatusLabel tone="attention">Unavailable</StatusLabel>}
              trailing={
                <Button variant="outline" size="sm" onClick={onCheck}>
                  Check again
                </Button>
              }
            />
          )}
        </SettingsList>
      </section>
      {integration && (
        <GithubRepositories
          integration={integration}
          onChanged={onChanged}
          {...(projectSetup && { projectSetup })}
        />
      )}
    </SettingsDrillIn>
  );
}
