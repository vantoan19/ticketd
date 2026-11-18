import { useContext, useEffect, useState } from "react";
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
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { useSyncStatus } from "@/features/sync/sync-status";
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
  // null until the read is back: a step already done then shows its check
  // instead of drawing it (Step's `settled`).
  const [skillInstalled, setSkillInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void agentSkillsClient.list().then(
      (skills) => {
        if (live)
          setSkillInstalled(
            skills.some(
              (skill) =>
                skill.state === "installed" ||
                skill.state === "update_available",
            ),
          );
      },
      () => {
        if (live) setSkillInstalled(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);
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
            {...(skillInstalled && { state: "done" as const })}
            settled={skillInstalled !== null}
            title={
              <>
                Let your agents in
                {skillInstalled && <span className="sr-only"> — Complete</span>}
              </>
            }
            description="Install the ticketd skill so Claude Code and Codex can read and update tickets."
            action={
              <Tooltip
                content="Open Agent skills"
                shortcut={shortcutLabel("go-agent-skills")}
              >
                <Button
                  size="compact"
                  variant="outline"
                  aria-keyshortcuts={ariaKeyShortcuts("go-agent-skills")}
                  onClick={() => settings?.("agent-skills")}
                >
                  Install skill
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
                Keep it on every Mac{" "}
                <span className="ui-guide-optional">· optional</span>
                {status?.connection === "connected" && (
                  <span className="sr-only"> — Complete</span>
                )}
              </>
            }
            description="Sync this workspace through your own Google Drive."
            action={
              <Tooltip
                content="Open Google Drive sync"
                shortcut={shortcutLabel("go-sync")}
              >
                <Button
                  size="compact"
                  variant="ghost"
                  aria-keyshortcuts={ariaKeyShortcuts("go-sync")}
                  onClick={() => settings?.("google-drive")}
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
