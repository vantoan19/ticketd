import { useEffect, useState } from "react";
import { Bot, ExternalLink, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import {
  useChatClient,
  type HarnessOptions,
  type HarnessStatus,
} from "@/features/chats/client";
import { useHarnessCatalog } from "@/features/chats/harness-catalog";
import {
  modelOf,
  rememberedPick,
  rememberHarness,
  startPick,
} from "@/features/chats/harness-pick";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { useChatFeature } from "@/features/chats/use-chats";
import { useAgentChecks } from "@/features/settings/agent-checks";
import {
  agentLine,
  isInstalled,
  plainMessage,
  signInCommand,
} from "@/features/settings/agents";
import { CopyCommand } from "@/features/settings/CopyCommand";
import { SettingsDrillIn } from "@/features/settings/layout/SettingsDrillIn";
import {
  SettingsList,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";

/**
 * Settings › Agents › one agent, opened in place: how it signs in, which
 * program ticketd runs, and what New Chat last started it with. Nothing here
 * is set; each fact belongs to the agent or to New Chat.
 */
export function AgentPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { enabled } = useChatFeature();
  // The Agents page already checked; this reads that answer, and rechecks when
  // the window regains focus (a person signs in in a terminal and comes back).
  const { checks, checkAgain } = useAgentChecks({
    active: enabled,
    readOnShow: false,
  });
  const info = useHarnessCatalog().find((entry) => entry.id === id);
  const agent = checks.harnesses.find((entry) => entry.id === id);
  const settled = checks.phase === "done" || checks.phase === "failed";
  // An agent that is not there (an old link) has no page.
  useEffect(() => {
    if (settled && !agent) onBack();
  }, [settled, agent, onBack]);
  const name = agent?.name ?? info?.name ?? id;
  const markId = agent?.mark_id ?? info?.mark_id;
  return (
    <SettingsDrillIn
      parent="agents"
      onBack={onBack}
      label={name}
      icon={Bot}
      iconContent={
        <HarnessMark harness={id} markId={markId} name={name} decorative />
      }
      lede="Runs your Chats with its own sign-in and settings."
    >
      {agent ? (
        <AgentFacts agent={agent} checkAgain={checkAgain} />
      ) : (
        <div role="status" aria-label={`Checking ${name}`}>
          <SettingsSection title="Sign-in">
            <SettingsList>
              <SettingsRow>
                <Skeleton className="h-2.5 w-30" />
                <Skeleton className="mt-2 h-2 w-50" />
              </SettingsRow>
            </SettingsList>
          </SettingsSection>
        </div>
      )}
    </SettingsDrillIn>
  );
}

function AgentFacts({
  agent,
  checkAgain,
}: {
  agent: HarnessStatus;
  checkAgain: () => void;
}) {
  const line = agentLine(agent);
  const command = signInCommand(agent);
  const installed = isInstalled(agent);
  return (
    <>
      {installed && (
        <SettingsSection title="Sign-in">
          <SettingsList>
            <SettingsRow
              leading={
                <SettingsRowTile>
                  <UserRound />
                </SettingsRowTile>
              }
              title={
                <StatusLabel tone={line.tone}>
                  {agent.status === "ready" ? "Signed in" : line.label}
                </StatusLabel>
              }
              description={signInText(agent, command)}
              trailing={
                agent.status === "not_signed_in" && agent.command ? (
                  <CopyCommand command={agent.command} agent={agent.name} />
                ) : agent.status === "unknown" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={checkAgain}
                  >
                    Check again
                  </Button>
                ) : undefined
              }
            />
          </SettingsList>
        </SettingsSection>
      )}
      <SettingsSection title="Program">
        {installed ? (
          <SettingsList>
            <dl className="cli-details">
              <dt>Version</dt>
              <dd>
                <span className="cli-code">{agent.version ?? "Unknown"}</span>
              </dd>
              <dt>Path</dt>
              <dd>
                {agent.path ? (
                  <span className="cli-path">
                    <PathText path={agent.path} layout="inline" />
                  </span>
                ) : (
                  "Unknown"
                )}
              </dd>
            </dl>
          </SettingsList>
        ) : (
          <NotFound agent={agent} />
        )}
      </SettingsSection>
      {agent.usable && <NewChatStart agent={agent} />}
    </>
  );
}

/** One sentence on how this agent signs in, and how to switch accounts. */
function signInText(agent: HarnessStatus, command: string | null) {
  const switching = command ? (
    <>
      To switch accounts, run <code className="font-mono">{command}</code> in a
      terminal.
    </>
  ) : null;
  switch (agent.status) {
    case "not_signed_in":
      return (
        <>
          {agent.name} keeps its own sign-in.{" "}
          {command ? (
            <>
              Run <code className="font-mono">{command}</code> in a terminal to
              sign in.
            </>
          ) : null}
        </>
      );
    case "not_subscription":
      return (
        <>
          Signed in with an API key or cloud provider, so {agent.name} bills
          usage there. {switching}
        </>
      );
    case "sign_in_unknown":
      return (
        <>
          ticketd can’t check this sign-in. {agent.name} says if it needs one
          when a Chat starts. {switching}
        </>
      );
    case "unknown":
      return plainMessage(agent) ?? `ticketd couldn’t check ${agent.name}.`;
    default:
      return (
        <>
          {agent.name} keeps its own sign-in. {switching}
        </>
      );
  }
}

/** An agent ticketd can't run: what is wrong, and where to get it. */
function NotFound({ agent }: { agent: HarnessStatus }) {
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const line = agentLine(agent);
  return (
    <>
      <SettingsList>
        <SettingsRow
          title={line.label}
          description={
            agent.status === "not_installed"
              ? line.description
              : (plainMessage(agent) ?? line.description)
          }
          trailing={
            agent.help_url ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void workspaceClient.openLink(agent.help_url ?? "").then(
                    () => setFailure(null),
                    (reason: unknown) =>
                      setFailure(
                        describeFailure(reason, `open the ${agent.name} page`),
                      ),
                  )
                }
              >
                Get {agent.name}
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : undefined
          }
        />
      </SettingsList>
      {failure && (
        <FailureAlert size="compact" failure={failure} className="mt-3" />
      )}
    </>
  );
}

/**
 * What New Chat last used for this agent, as a fact with the way to change it:
 * a remembered pick, named as New Chat names it. It is not a second picker.
 */
function NewChatStart({ agent }: { agent: HarnessStatus }) {
  const client = useChatClient();
  const { requestChat } = useChatFeature();
  const [options, setOptions] = useState<HarnessOptions | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let current = true;
    client.harnessOptions(agent.id).then(
      (offered) => current && setOptions(offered),
      () => current && setOptions(null),
    );
    return () => {
      current = false;
    };
  }, [client, agent.id]);
  const line = options ? startLine(options) : null;
  return (
    <SettingsSection title="New Chat starts with">
      <SettingsList>
        <SettingsRow
          title={
            options === undefined ? (
              <Skeleton className="h-2.5 w-50" />
            ) : (
              (line ?? `${agent.name}’s own settings`)
            )
          }
          description={`What you last chose for ${agent.name}. Change it in New Chat.`}
          trailing={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                rememberHarness(agent.id);
                requestChat({ kind: "new" });
              }}
            >
              Open New Chat
            </Button>
          }
        />
      </SettingsList>
    </SettingsSection>
  );
}

/** "Opus 5.5 · High · Ask before edits": the remembered pick, in the picker's own words. */
function startLine(options: HarnessOptions) {
  const pick = startPick(options, rememberedPick(options.harness_id));
  const model = modelOf(options, pick);
  const parts = [
    model?.runs_as ?? model?.label,
    model?.efforts.find((effort) => effort.id === pick.effort)?.label,
    options.permission?.options.find((item) => item.id === pick.permission)
      ?.label,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
