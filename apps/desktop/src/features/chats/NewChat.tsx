import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Folder,
  Maximize2,
  Minimize2,
  SquareTerminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import {
  useChatClient,
  type HarnessStatus,
  type LinkedRecord,
  type ProblemKind,
} from "@/features/chats/client";
import { ProblemNotice } from "@/features/chats/ChatDetail";
import { Composer } from "@/features/chats/Composer";
import { LinkPicker, RecordChip } from "@/features/chats/LinkPicker";
import { harnessUsable } from "@/features/chats/model";

const STATUS_PROBLEM: Record<
  Exclude<HarnessStatus["status"], "ready">,
  ProblemKind
> = {
  not_installed: "not_installed",
  incompatible: "incompatible",
  not_signed_in: "not_signed_in",
  not_subscription: "not_subscription",
  sign_in_unknown: "sign_in_unknown",
  unknown: "probe_failed",
};

/** The draft survives leaving and returning to New Chat while the app is open. */
let draft = "";

/**
 * Starts a Chat: a first message, the harness (chosen only here), the folder
 * it works in, and any records to link. A folder is required; a Project or
 * ticket is not.
 */
export function NewChat({
  expanded,
  single,
  onExpand,
  onReturn,
  onClose,
  onCreated,
}: {
  expanded: boolean;
  single: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const client = useChatClient();
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const [harnessId, setHarnessId] = useState("");
  /** null is the managed folder ticketd keeps for the Chat. */
  const [folder, setFolder] = useState<string | null>(null);
  const [shared, setShared] = useState(0);
  const [links, setLinks] = useState<LinkedRecord[]>([]);
  const [failure, setFailure] = useState("");
  const [probe, setProbe] = useState(0);
  /** Names this attempt to the host, so sending again after a failure finds the same Chat. */
  const attempt = useRef(crypto.randomUUID());
  useEffect(() => {
    let current = true;
    client.harnesses().then(
      (found) => current && setHarnesses(found),
      (reason: unknown) => current && setFailure(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [client, probe]);
  useEffect(() => {
    let current = true;
    (folder ? client.folderUse(folder) : Promise.resolve(0)).then(
      (count) => current && setShared(count),
      () => current && setShared(0),
    );
    return () => {
      current = false;
    };
  }, [client, folder]);
  const harness =
    harnesses.find((item) => item.id === harnessId) ??
    harnesses.find((item) => item.status === "ready") ??
    harnesses.find((item) => harnessUsable(item.status)) ??
    harnesses[0];
  const ready = harness !== undefined && harnessUsable(harness.status);
  const folderName = folder?.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <section className="ticket-detail chat-pane" aria-labelledby="chat-heading">
      <div className="detail-header">
        <div className="detail-title-group">
          {single && (
            <IconButton label="Back to Chats" onClick={onReturn}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          <h2 id="chat-heading" className="chat-head-title" tabIndex={-1}>
            New Chat
          </h2>
        </div>
        <div className="detail-actions">
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 aria-hidden />
            </IconButton>
          ) : (
            !single && (
              <IconButton label="Expand Chat" onClick={onExpand}>
                <Maximize2 aria-hidden />
              </IconButton>
            )
          )}
          <IconButton label="Close Chat" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
      </div>
      <div className="chat-new">
        <h2>What should we work on?</h2>
        <Composer
          autoFocus
          placeholder="Describe a task or ask a question"
          initialText={draft}
          onText={(text) => (draft = text)}
          controls={(text) => ({
            kind: "send",
            enabled: ready && text.trim() !== "",
          })}
          onSend={async (message) => {
            if (!harness) return;
            try {
              const created = await client.createChat({
                command_id: attempt.current,
                harness_id: harness.id,
                folder,
                links: links.map(({ kind, id }) => ({ kind, id })),
                message,
              });
              // The Chat exists but holds no message: sending again reaches the
              // same Chat instead of starting another.
              if (created.send_error) throw new Error(created.send_error);
              attempt.current = crypto.randomUUID();
              setFailure("");
              onCreated(created.chat_id);
            } catch (reason) {
              setFailure(
                `Could not start the Chat: ${reason instanceof Error ? reason.message : String(reason)}`,
              );
              throw reason;
            }
          }}
        />
        <div className="chat-chips">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Harness: ${harness?.name ?? "none found"}`}
              >
                <SquareTerminal aria-hidden />
                {harness?.name ?? "No harness"}
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                value={harness?.id ?? ""}
                onValueChange={setHarnessId}
              >
                {harnesses.map((item) => (
                  <DropdownMenuRadioItem key={item.id} value={item.id}>
                    {item.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Folder: ${folder ?? "a folder kept by ticketd"}`}
              >
                <Folder aria-hidden />
                {folderName ?? "ticketd folder"}
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() =>
                  void client.pickFolder().then(
                    (path) => path && setFolder(path),
                    (reason: unknown) => setFailure(String(reason)),
                  )
                }
              >
                Choose a folder…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFolder(null)}>
                Use a folder kept by ticketd
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {links.map((record) => (
            <RecordChip
              key={`${record.kind}:${record.id}`}
              record={record}
              onRemove={() => setLinks(links.filter((item) => item !== record))}
            />
          ))}
          <LinkPicker
            withLabel
            linked={links}
            onPick={(record) => setLinks([...links, record])}
          />
        </div>
        {shared > 0 && (
          <p className="chat-fine">
            {shared === 1
              ? "1 other Chat uses this folder."
              : `${shared} other Chats use this folder.`}
          </p>
        )}
        {harness && harness.status !== "ready" && (
          <ProblemNotice
            problem={{
              kind: STATUS_PROBLEM[harness.status],
              message: harness.message,
              command: harness.command,
              help_url: harness.help_url,
            }}
            harness={harness.name}
            onAction={() => setProbe((count) => count + 1)}
          />
        )}
        {failure && (
          <p className="chat-fine" role="alert">
            {failure}
          </p>
        )}
      </div>
    </section>
  );
}
