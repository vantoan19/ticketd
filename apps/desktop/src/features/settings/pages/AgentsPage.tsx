import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import { ExperimentalCard } from "@/features/chats/ExperimentalCard";
import { HarnessMark } from "@/features/chats/HarnessMark";
import type { HarnessStatus } from "@/features/chats/client";
import { useChatFeature } from "@/features/chats/use-chats";
import {
  useAgentChecks,
  useInstalledAgents,
  type AgentChecks,
} from "@/features/settings/agent-checks";
import { CopyCommand } from "@/features/settings/CopyCommand";
import { agentLine } from "@/features/settings/agents";
import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";

/** Settings › Agents: the Chats switch and the agents on this computer. */
export function AgentsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { enabled } = useChatFeature();
  const { openPage } = useSettingsState();
  // Sign-in is checked only while Chats are on, and again whenever the window
  // regains focus; with Chats off nothing here asks an agent anything but its version.
  const { checks, checkAgain } = useAgentChecks({ active: enabled });
  return (
    <SettingsPage {...sectionMeta("agents")}>
      <ExperimentalCard />
      <SettingsSection
        title="On this computer"
        actions={
          enabled ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={checks.phase === "loading"}
              onClick={checkAgain}
            >
              <RefreshCw aria-hidden="true" />
              Check again
            </Button>
          ) : undefined
        }
        caption={
          <>
            To let them use ticketd in their own terminal, see{" "}
            <SettingsLink onClick={() => openPage("agent-skills")}>
              Agent skills
            </SettingsLink>
            .
          </>
        }
      >
        {enabled ? (
          <CheckedAgents
            checks={checks}
            checkAgain={checkAgain}
            onOpen={onOpen}
          />
        ) : (
          <FoundAgents />
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

function AgentTile({
  id,
  markId,
  name,
  dim,
}: {
  id: string;
  markId?: string | undefined;
  name: string;
  dim: boolean;
}) {
  return (
    <SettingsRowTile>
      <HarnessMark
        harness={id}
        markId={markId}
        name={name}
        dim={dim}
        decorative
      />
    </SettingsRowTile>
  );
}

/**
 * Chats are off: the agents ticketd found and their versions, nothing more.
 * No sign-in is checked, no row opens, nothing is flagged.
 */
function FoundAgents() {
  const found = useInstalledAgents({ active: true });
  if (found.phase === "failed")
    return <FailureState size="inline" failure={found.failure} />;
  return (
    <SettingsList>
      {found.phase === "loading" ? (
        <div role="status" aria-label="Looking for the agents">
          <SettingsRow leading={<SettingsRowTile>{null}</SettingsRowTile>}>
            <Skeleton className="h-2.5 w-30" />
            <Skeleton className="mt-2 h-2 w-50" />
          </SettingsRow>
        </div>
      ) : (
        <div role="list" aria-label="Agents">
          {found.agents.map((agent) => (
            <SettingsRow
              key={agent.id}
              role="listitem"
              leading={
                <AgentTile
                  id={agent.id}
                  markId={agent.mark_id}
                  name={agent.name}
                  dim={!agent.installed}
                />
              }
              title={agent.name}
              description={
                agent.installed
                  ? agent.version
                    ? `Version ${agent.version}`
                    : "Installed"
                  : "Not installed"
              }
            />
          ))}
        </div>
      )}
    </SettingsList>
  );
}

/** Chats are on: each agent's readiness and its one fix; a row opens the agent. */
function CheckedAgents({
  checks,
  checkAgain,
  onOpen,
}: {
  checks: AgentChecks;
  checkAgain: () => void;
  onOpen: (id: string) => void;
}) {
  if (checks.phase === "failed" && checks.harnesses.length === 0)
    return (
      <FailureState
        size="inline"
        failure={checks.failure}
        onRetry={checkAgain}
      />
    );
  const first = checks.harnesses.length === 0;
  return (
    <SettingsList>
      {first ? (
        <div role="status" aria-label="Checking the agents">
          <SettingsRow leading={<SettingsRowTile>{null}</SettingsRowTile>}>
            <Skeleton className="h-2.5 w-30" />
            <Skeleton className="mt-2 h-2 w-50" />
          </SettingsRow>
        </div>
      ) : (
        <div role="list" aria-label="Agents">
          {checks.harnesses.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onOpen={onOpen}
              onCheckAgain={checkAgain}
            />
          ))}
        </div>
      )}
      <SettingsListFooter>
        Each agent keeps its own sign-in. ticketd never sees your passwords or
        keys.
      </SettingsListFooter>
    </SettingsList>
  );
}

function AgentRow({
  agent,
  onOpen,
  onCheckAgain,
}: {
  agent: HarnessStatus;
  onOpen: (id: string) => void;
  onCheckAgain: () => void;
}) {
  const line = agentLine(agent);
  return (
    <SettingsRow
      role="listitem"
      leading={
        <AgentTile
          id={agent.id}
          markId={agent.mark_id}
          name={agent.name}
          dim={agent.status === "not_installed"}
        />
      }
      title={agent.name}
      {...(line.description && { description: line.description })}
      onOpen={() => onOpen(agent.id)}
      openLabel={`Open ${agent.name}`}
      trailing={
        <>
          <StatusLabel tone={line.tone} size="caption">
            {line.label}
          </StatusLabel>
          {agent.status === "not_signed_in" && agent.command && (
            <CopyCommand command={agent.command} agent={agent.name} />
          )}
          {agent.status === "unknown" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCheckAgain}
            >
              Check again
            </Button>
          )}
        </>
      }
    />
  );
}
