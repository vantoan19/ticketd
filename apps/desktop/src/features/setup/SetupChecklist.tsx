import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Step, Steps } from "@/components/ui/steps";
import { client } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { notificationClient } from "@/lib/api/notifications";
import {
  askForNotifications,
  useNotificationPermission,
} from "@/lib/notification-permission";
import { homeRelative } from "@/lib/paths";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { installForAgents } from "@/features/setup/install-agents";
import { SetupActionsContext } from "@/features/setup/setup-actions";
import {
  setupStep,
  type AgentsAction,
  type SetupState,
  type SetupStep,
} from "@/features/setup/setup-state";

const FIND_READY = {
  query: "",
  project: null,
  unlinked: false,
  plan: null,
  status: null,
  tags: [],
  availability: "Ready",
  family: null,
  order: "Newest",
  limit: 1,
  offset: 0,
} as const;

/** "Bring in …" with the mark of an optional step, as the guide draws it. */
function Title({ step }: { step: SetupStep }) {
  if (!step.optional) return <>{step.title}</>;
  // Non-breaking spaces tie the mark to the title's last word, so a wrapped
  // title never leaves "· optional" alone on a line.
  return (
    <>
      {step.title}
      {"\u00a0"}
      <span className="ui-guide-optional">·&nbsp;optional</span>
    </>
  );
}

/**
 * The weight of an optional step's button: ghost while a step that is needed
 * still waits, outline once only optional steps remain.
 */
function optionalVariant(state: SetupState) {
  return state.current === null ? "outline" : "ghost";
}

/** A wrapper for two actions that share the step's one end cell. */
function Actions({ children }: { children: ReactNode }) {
  return <span data-slot="step-actions">{children}</span>;
}

/** The newest Ready ticket, read once, while the step still needs to name one. */
function useNewestReadyTicket(needed: boolean) {
  const [reference, setReference] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void client.findTicketRows({ ...FIND_READY, tags: [] }).then(
      (rows) => {
        if (live) setReference(rows[0]?.reference ?? null);
      },
      () => {
        if (live) setReference(null);
      },
    );
    return () => {
      live = false;
    };
  }, [needed]);
  return reference;
}

/** Step 1: one button runs the command's install and each agent's skill. */
function AgentsStep({ step, state }: { step: SetupStep; state: SetupState }) {
  const { openPage, refreshIndicators } = useSettingsState();
  const action: AgentsAction | undefined = step.agentsAction;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [skillFailures, setSkillFailures] = useState<
    Record<string, FailureDescription>
  >({});
  const [declined, setDeclined] = useState<string | null>(null);
  const current = state.current === "agents";
  const run = async (inUserBin: boolean) => {
    if (action?.kind !== "install") return;
    setBusy(true);
    setFailure(null);
    setSkillFailures({});
    setDeclined(null);
    try {
      const result = await installForAgents(action, { inUserBin });
      if (result.command?.outcome === "declined")
        setDeclined(result.command.directory);
      setSkillFailures(result.failures);
    } catch (reason) {
      setFailure(describeFailure(reason, "install the command-line tool"));
    } finally {
      // Read what is true now, whatever happened, so the step ticks or says why.
      refreshIndicators("command-line", { refreshPath: true });
      refreshIndicators("agent-skills");
      setBusy(false);
    }
  };
  const failed = Object.values(skillFailures);
  return (
    <Step
      {...(step.done && { state: "done" as const })}
      {...(!step.done && current && { state: "current" as const })}
      settled={step.settled}
      title={<Title step={step} />}
      description={
        declined
          ? "Nothing changed. A link in your own folder needs no password."
          : step.description
      }
      action={
        step.done || !action ? undefined : action.kind === "open" ? (
          <Button
            size="sm"
            variant={current ? "outline" : "ghost"}
            onClick={() => openPage(action.page)}
          >
            {action.label}
          </Button>
        ) : declined ? (
          <Button
            size="sm"
            variant="outline"
            busy={busy}
            onClick={() => void run(true)}
          >
            Use {homeRelative(declined)} instead
          </Button>
        ) : (
          <Button
            size="sm"
            variant={current ? "default" : "ghost"}
            busy={busy}
            onClick={() => void run(false)}
          >
            {busy ? "Installing…" : action.label}
          </Button>
        )
      }
    >
      {(failure || failed.length > 0) && (
        <>
          {failure && (
            <FailureAlert
              size="compact"
              failure={failure}
              onRetry={() => void run(false)}
            />
          )}
          {failed.map((each) => (
            <FailureAlert
              key={each.title}
              size="compact"
              failure={each}
              onRetry={() => void run(false)}
            />
          ))}
        </>
      )}
    </Step>
  );
}

/** Step 2: a prompt to paste into an agent, or the way to make a ticket for one. */
function AgentUpdateStep({
  step,
  state,
}: {
  step: SetupStep;
  state: SetupState;
}) {
  const actions = useContext(SetupActionsContext);
  const current = state.current === "agent-update";
  const reference = useNewestReadyTicket(current);
  const trigger = useRef<HTMLButtonElement>(null);
  const startChat = actions?.startChat ?? null;
  const showsPrompt = current && typeof reference === "string";
  return (
    <Step
      {...(step.done && { state: "done" as const })}
      {...(current && { state: "current" as const })}
      settled={step.settled}
      title={<Title step={step} />}
      description={
        step.done || current
          ? step.description
          : "Once agents can use ticketd, paste a prompt into Claude Code or Codex."
      }
      action={
        current && actions && reference !== undefined ? (
          <Actions>
            {reference === null && (
              <Button
                ref={trigger}
                size="sm"
                aria-disabled={!!actions.newTicketDisabledReason}
                aria-description={actions.newTicketDisabledReason ?? undefined}
                onClick={() => {
                  if (!actions.newTicketDisabledReason && trigger.current)
                    actions.newTicket(trigger.current);
                }}
              >
                New ticket
              </Button>
            )}
            {startChat && (
              <Button size="sm" variant="outline" onClick={startChat}>
                Start a Chat
              </Button>
            )}
          </Actions>
        ) : undefined
      }
    >
      {showsPrompt && (
        <CommandBlock
          plain
          command={`Use ticketd to pick up ${reference}, then post an update on it.`}
          copyLabel="Copy the prompt"
        />
      )}
    </Step>
  );
}

/** Step 5: asks for notifications here, and shows what a block needs. */
function NotificationsStep({
  step,
  state,
}: {
  step: SetupStep;
  state: SetupState;
}) {
  const permission = useNotificationPermission();
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const variant = optionalVariant(state);
  const allow = async () => {
    setAsking(true);
    setFailure(null);
    try {
      await askForNotifications();
    } catch (reason) {
      setFailure(describeFailure(reason, "ask for notification permission"));
    } finally {
      setAsking(false);
    }
  };
  const openSettings = async () => {
    setFailure(null);
    try {
      await notificationClient.openSettings();
    } catch (reason) {
      setFailure(describeFailure(reason, "open System Settings"));
    }
  };
  return (
    <Step
      {...(step.done && { state: "done" as const })}
      settled={step.settled}
      title={<Title step={step} />}
      description={step.description}
      action={
        step.done || !permission ? undefined : permission.state ===
          "not_asked" ? (
          <Button
            size="sm"
            variant={variant}
            disabled={asking}
            onClick={() => void allow()}
          >
            Allow notifications
          </Button>
        ) : permission.settings ? (
          <Button
            size="sm"
            variant={variant}
            onClick={() => void openSettings()}
          >
            Open System Settings
          </Button>
        ) : undefined
      }
    >
      {failure && <FailureAlert size="compact" failure={failure} />}
    </Step>
  );
}

/**
 * The five steps of Set up ticketd, each ticked from this computer's real
 * state and acting right on its row. The same Steps list the first-run guide
 * draws, here as a page of Settings.
 */
export function SetupChecklist() {
  const { setup, openPage } = useSettingsState();
  if (!setup) return null;
  const variant = optionalVariant(setup);
  const sources = setupStep(setup, "sources");
  const sync = setupStep(setup, "sync");
  return (
    <Steps variant="settings" label="Setup steps">
      <AgentsStep step={setupStep(setup, "agents")} state={setup} />
      <AgentUpdateStep step={setupStep(setup, "agent-update")} state={setup} />
      <Step
        {...(sources.done && { state: "done" as const })}
        settled={sources.settled}
        title={<Title step={sources} />}
        description={sources.description}
        action={
          sources.done || !sources.settled ? undefined : (
            <Button
              size="sm"
              variant={variant}
              onClick={() => openPage("ticket-sources")}
            >
              Add a source
            </Button>
          )
        }
      />
      <Step
        {...(sync.done && { state: "done" as const })}
        settled={sync.settled}
        title={<Title step={sync} />}
        description={sync.description}
        action={
          sync.done || !sync.settled ? undefined : (
            <Button
              size="sm"
              variant={variant}
              onClick={() => openPage("workspace-sync")}
            >
              Set up sync
            </Button>
          )
        }
      />
      <NotificationsStep
        step={setupStep(setup, "notifications")}
        state={setup}
      />
    </Steps>
  );
}
