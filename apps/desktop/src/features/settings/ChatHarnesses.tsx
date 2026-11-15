import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import type { StatusDotTone } from "@/components/ui/status-dot";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useChatClient, type HarnessStatus } from "@/features/chats/client";
import { HarnessMark } from "@/features/chats/HarnessMark";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { useSettingsState } from "@/features/settings/use-settings-state";

type Load =
  | { phase: "loading" }
  | { phase: "failed"; failure: FailureDescription }
  | { phase: "done"; harnesses: HarnessStatus[] };

/**
 * The harness's own word when it isn't ready ("Not installed", "Sign in"),
 * in the attention tone when the person has a step to take; "Ready" otherwise.
 */
function harnessStatus(harness: HarnessStatus): {
  label: string;
  tone: StatusDotTone;
} {
  if (harness.word)
    return {
      label: harness.word.word,
      tone: harness.word.dot ? "attention" : "neutral",
    };
  if (harness.status === "ready") return { label: "Ready", tone: "positive" };
  return {
    label: harness.usable ? "Usable" : "Not ready",
    tone: harness.usable ? "neutral" : "attention",
  };
}

/** What was found, in one line: version, or the host's reason. */
function harnessDetail(harness: HarnessStatus) {
  if (harness.status === "ready" && harness.version)
    return `Version ${harness.version}.`;
  return harness.problem?.title ?? harness.message ?? undefined;
}

/**
 * Settings › Chat: whether Claude Code and Codex can run here, one row each
 * with its official mark and status, the command to copy where one helps,
 * and Check again. The nav's Needs setup dot on Chat follows this list.
 */
export function ChatHarnesses() {
  const client = useChatClient();
  const { refreshIndicators } = useSettingsState();
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const read = useCallback(
    () =>
      client.harnesses().then(
        (harnesses) => setLoad({ phase: "done", harnesses }),
        (reason: unknown) =>
          setLoad({
            phase: "failed",
            failure: describeFailure(reason, "check the harnesses"),
          }),
      ),
    [client],
  );
  // The first read: state starts as "loading", so only the result is set.
  useEffect(() => {
    void read();
  }, [read]);
  const checkAgain = () => {
    setLoad({ phase: "loading" });
    void read();
    refreshIndicators("chat");
  };
  return (
    <SettingsSection
      title="Harnesses"
      caption="Chat runs the copy of Claude Code or Codex installed on this computer, signed in as you."
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={load.phase === "loading"}
          onClick={checkAgain}
        >
          <RefreshCw aria-hidden="true" />
          Check again
        </Button>
      }
    >
      {load.phase === "failed" ? (
        <FailureState
          size="inline"
          failure={load.failure}
          onRetry={checkAgain}
        />
      ) : (
        <SettingsList>
          {load.phase === "loading" ? (
            <div role="status" aria-label="Checking the harnesses">
              <SettingsRow leading={<SettingsRowTile>{null}</SettingsRowTile>}>
                <Skeleton className="h-2.5 w-30" />
                <Skeleton className="mt-2 h-2 w-50" />
              </SettingsRow>
            </div>
          ) : (
            <div role="list" aria-label="Harnesses">
              {load.harnesses.map((harness) => {
                const status = harnessStatus(harness);
                const detail = harnessDetail(harness);
                const command =
                  harness.status === "ready" ? null : harness.command;
                return (
                  <SettingsRow
                    key={harness.id}
                    role="listitem"
                    leading={
                      <SettingsRowTile>
                        <HarnessMark
                          harness={harness.id}
                          name={harness.name}
                          dim={harness.status === "not_installed"}
                          decorative
                        />
                      </SettingsRowTile>
                    }
                    title={harness.name}
                    {...(detail && { description: detail })}
                    trailing={
                      <>
                        <StatusLabel tone={status.tone} size="caption">
                          {status.label}
                        </StatusLabel>
                        {command && (
                          <CopyButton
                            text={command}
                            label="Copy command"
                            subject={harness.name}
                          />
                        )}
                      </>
                    }
                  />
                );
              })}
            </div>
          )}
          <SettingsListFooter>
            ticketd never asks for your password or keys; each harness signs in
            on its own.
          </SettingsListFooter>
        </SettingsList>
      )}
    </SettingsSection>
  );
}
