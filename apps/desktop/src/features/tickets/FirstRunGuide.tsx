import { useContext, useEffect } from "react";
import { ListTodo } from "lucide-react";
import { enter } from "@/components/ui/enter";
import { Button } from "@/components/ui/button";
import { IconTile } from "@/components/ui/icon-tile";
import { PaneHeader } from "@/components/ui/list-header";
import { ManagementPage } from "@/components/ui/page-header";
import { Steps, Step } from "@/components/ui/steps";
import { Tooltip } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { emptyCopy } from "@/lib/empty-copy";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { SettingsNavigation } from "@/lib/settings-navigation";
import { useSyncStatus } from "@/features/sync/sync-status";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { setupStep } from "@/features/setup/setup-state";
import "./first-run.css";

/**
 * A guide to existing actions, with completion read from their real state.
 * It arrives in a short cascade (header, icon, title, lede, the steps card with
 * each step, hint) of its own (enter.ts). Once the list holds the first ticket
 * the guide is simply no longer rendered: it is a page of the shell, whose
 * picture of it fades out (ViewRegion) and which the list then replaces.
 */
export function FirstRunGuide({
  onCreate,
  disabledReason,
}: {
  onCreate: (trigger: HTMLButtonElement) => void;
  disabledReason: string | null;
}) {
  const settings = useContext(SettingsNavigation);
  const { status } = useSyncStatus();
  // The same state as Set up ticketd, so "Let your agents in" ticks only when
  // the command and every agent's skill are in place. Unread until it is back:
  // a step already done then shows its check instead of drawing it (Step's `settled`).
  const { setup, refreshIndicators } = useSettingsState();
  useEffect(() => refreshIndicators("command-line"), [refreshIndicators]);
  useEffect(() => refreshIndicators("agent-skills"), [refreshIndicators]);
  const agents = setup ? setupStep(setup, "agents") : null;
  const agentsReady = agents?.done ?? false;
  const copy = emptyCopy("workspace-first-run");
  return (
    <div className="first-run-host" data-own-entrance="">
      <div {...enter(0)}>
        <PaneHeader title="All tickets" />
      </div>
      <ManagementPage layout="guide" aria-labelledby="first-run-title">
        <div className="flex" {...enter(1)}>
          <IconTile>
            <ListTodo />
          </IconTile>
        </div>
        <div {...enter(2)}>
          <h2 id="first-run-title" className="ui-guide-title">
            {copy.title}
          </h2>
        </div>
        <div {...enter(3)}>
          <p className="ui-guide-lede">{copy.sentence}</p>
        </div>
        <Steps variant="settings" className="mt-4.5" enterFrom={4}>
          <Step
            state="current"
            title="Create your first ticket"
            description="Press C anywhere. Only a title is needed."
            action={
              <Tooltip
                content={disabledReason ?? "New ticket"}
                shortcut={shortcutLabel("new-ticket")}
              >
                <Button
                  size="compact"
                  aria-disabled={!!disabledReason}
                  aria-description={disabledReason ?? undefined}
                  aria-keyshortcuts={ariaKeyShortcuts("new-ticket")}
                  onClick={(event) => {
                    if (!disabledReason) onCreate(event.currentTarget);
                  }}
                >
                  New ticket{" "}
                  <Kbd tone="inverted">{shortcutLabel("new-ticket")}</Kbd>
                </Button>
              </Tooltip>
            }
          />
          <Step
            {...(agentsReady && { state: "done" as const })}
            settled={agents?.settled ?? false}
            title={
              <>
                Let your agents in
                {agentsReady && <span className="sr-only"> — Complete</span>}
              </>
            }
            description="Install the ticketd command and skill so Claude Code and Codex can read and update tickets."
            action={
              <Tooltip content="Open Set up ticketd">
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => settings?.("setup")}
                >
                  Set up ticketd
                </Button>
              </Tooltip>
            }
          />
          <Step
            {...(status?.connection === "connected" && {
              state: "done" as const,
            })}
            settled={status !== null}
            title={
              <>
                Keep it on every computer{" "}
                <span className="ui-guide-optional">· optional</span>
                {status?.connection === "connected" && (
                  <span className="sr-only"> — Complete</span>
                )}
              </>
            }
            description="Sync this workspace between your computers."
            action={
              <Tooltip
                content="Open Workspace sync"
                shortcut={shortcutLabel("go-sync")}
              >
                <Button
                  size="compact"
                  variant="ghost"
                  aria-keyshortcuts={ariaKeyShortcuts("go-sync")}
                  onClick={() => settings?.("workspace-sync")}
                >
                  Set up
                </Button>
              </Tooltip>
            }
          />
        </Steps>
        <div className="mt-3.5" {...enter(7)}>
          <p className="ui-guide-hint">
            Press <Kbd>{shortcutLabel("command-palette")}</Kbd> to search or
            jump anywhere.
          </p>
        </div>
      </ManagementPage>
    </div>
  );
}
