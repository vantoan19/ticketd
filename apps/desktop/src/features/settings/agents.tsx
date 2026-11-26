import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { StatusDotTone } from "@/components/ui/status-dot";
import { useCopy } from "@/components/ui/use-copy";
import type { HarnessStatus } from "@/features/chats/client";

/**
 * What an agent is, said once for the Agents page and an opened agent: its
 * word and dot, and one sentence on its sign-in or what is missing.
 */
export type AgentLine = {
  label: string;
  tone: StatusDotTone;
  /** The row's description; none when the word says it all. */
  description?: ReactNode;
};

const code = (command: string) => <code className="font-mono">{command}</code>;

/** The command that signs in or switches accounts: the fix when it is missing. */
export const signInCommand = (agent: HarnessStatus) =>
  agent.sign_in_command ?? agent.command ?? null;

/** Whether the program is on this computer and ticketd can talk to it. */
export const isInstalled = (agent: HarnessStatus) =>
  agent.status !== "not_installed" &&
  agent.status !== "incompatible" &&
  agent.status !== "unavailable";

/** The message without the code marks the host wraps a path in. */
export const plainMessage = (agent: HarnessStatus) =>
  agent.message?.replaceAll("`", "");

export function agentLine(agent: HarnessStatus): AgentLine {
  const version = agent.version ? ` · version ${agent.version}` : "";
  switch (agent.status) {
    case "ready":
      return {
        label: "Ready",
        tone: "positive",
        description: `Signed in${version}`,
      };
    case "not_signed_in":
      return {
        label: agent.word?.word ?? "Not signed in",
        tone: "attention",
        description: agent.command ? (
          <>Run {code(agent.command)} in a terminal to sign in.</>
        ) : undefined,
      };
    case "not_installed":
      return {
        label: agent.word?.word ?? "Not installed",
        tone: "neutral",
        description: `Install ${agent.name} to use it here.`,
      };
    case "incompatible":
      return {
        label: agent.word?.word ?? "Can't be used",
        tone: "attention",
        description: `Update ${agent.name} to use it here.`,
      };
    case "unavailable":
      return {
        label: agent.word?.word ?? "Can't be used",
        tone: "attention",
        description:
          plainMessage(agent) ?? `ticketd's part for ${agent.name} is missing.`,
      };
    case "not_subscription":
      return {
        label: agent.word?.word ?? "Not on a subscription",
        tone: "attention",
        description: `Signed in with an API key or cloud provider, so ${agent.name} bills usage there.`,
      };
    case "sign_in_unknown":
      return {
        label: agent.word?.word ?? "Sign-in not checked",
        tone: "neutral",
        description: `Sign-in is checked when a Chat starts${version}`,
      };
    case "unknown":
      return { label: agent.word?.word ?? "Couldn't check", tone: "neutral" };
  }
}

/** A labelled button that copies a command, so the fix is never an unlabelled icon. */
export function CopyCommand({
  command,
  agent,
}: {
  command: string;
  agent: string;
}) {
  const { copied, error, copy } = useCopy();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Copy command for ${agent}`}
        onClick={() => void copy("command", command)}
      >
        {copied ? "Copied" : "Copy command"}
      </Button>
      <span className="sr-only" role="status">
        {error}
      </span>
    </>
  );
}
