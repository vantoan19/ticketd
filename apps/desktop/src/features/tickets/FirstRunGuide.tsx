import { useContext, useEffect, useState } from "react";
import { ListTodo } from "lucide-react";
import { m, useIsPresent } from "motion/react";
import { Appear } from "@/components/ui/motion";
import { exitTransition } from "@/lib/motion-tokens";
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
 * It arrives in a short cascade (icon, title, lede, steps, hint) and, rendered
 * inside `Presence`, fades out once the first ticket exists.
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
  const [skillInstalled, setSkillInstalled] = useState(false);
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
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const copy = emptyCopy("workspace-first-run");
  const present = useIsPresent();
  return (
    <m.div
      className="first-run-host"
      // Leaving, it lets go of its space so the list does not share the panel.
      data-leaving={!present || undefined}
      exit={{ opacity: 0, transition: exitTransition() }}
    >
      <PaneHeader title="All tickets" />
      <ManagementPage layout="guide" aria-labelledby="first-run-title">
        <Appear className="flex">
          <IconTile>
            <ListTodo />
          </IconTile>
        </Appear>
        <Appear index={1}>
          <h2 id="first-run-title" className="ui-guide-title">
            {copy.title}
          </h2>
        </Appear>
        <Appear index={2}>
          <p className="ui-guide-lede">{copy.sentence}</p>
        </Appear>
        <Appear index={3} className="mt-4.5">
          <Steps variant="settings">
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
              title={
                <>
                  Let your agents in
                  {skillInstalled && (
                    <span className="sr-only"> — Complete</span>
                  )}
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
        </Appear>
        <Appear index={4} className="mt-3.5">
          <p className="ui-guide-hint">
            Press <Kbd>{shortcutLabel("command-palette")}</Kbd> to search or
            jump anywhere.
          </p>
        </Appear>
      </ManagementPage>
    </m.div>
  );
}
