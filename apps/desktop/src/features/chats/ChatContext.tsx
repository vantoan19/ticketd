import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Folder,
  FolderOpen,
  FolderX,
  GitBranch,
  MessagesSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { useCopy } from "@/components/ui/use-copy";
import { fileManagerName } from "@/lib/platform";
import { PathText } from "@/features/projects/PathText";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import {
  useChatClient,
  type ChatState,
  type HarnessStatus,
} from "@/features/chats/client";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { contextLabel, folderLabel, harnessWord } from "@/features/chats/model";

/** The folder's Project icon, else the folder; a missing folder says so. */
function FolderLead({ chat }: { chat: ChatState }) {
  if (chat.folder.missing) return <FolderX aria-hidden />;
  if (chat.folder.project) return <ProjectIcon project={chat.folder.project} />;
  return <Folder aria-hidden />;
}

function HarnessSection({ chat }: { chat: ChatState }) {
  const client = useChatClient();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [checks, setChecks] = useState(0);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let current = true;
    client.harnesses().then(
      (found) => {
        if (!current) return;
        setStatus(found.find((item) => item.id === chat.harness.id) ?? null);
        setChecking(false);
      },
      () => current && setChecking(false),
    );
    return () => {
      current = false;
    };
  }, [client, chat.harness.id, checks]);
  const word = status && harnessWord(status.status);
  const found = [status?.version, status?.path].filter(Boolean);
  return (
    <section>
      <h3>Harness</h3>
      <p className="chat-pop-line">
        <HarnessMark
          harness={chat.harness.id}
          name={chat.harness.name}
          decorative
        />
        <span>{chat.harness.name}</span>
      </p>
      {found.length > 0 && (
        <small>
          {status?.version}
          {found.length > 1 && " · "}
          {status?.path && <code className="chat-mono">{status.path}</code>}
        </small>
      )}
      <div className="chat-pop-status">
        <span role="status">
          {checking ? (
            "Checking…"
          ) : status ? (
            <>
              {(!word || word.dot) && (
                <StatusDot tone={word ? "attention" : "positive"} />
              )}
              {word?.word ?? "Signed in"}
            </>
          ) : (
            "Couldn't check"
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            setChecks((count) => count + 1);
          }}
        >
          Check again
        </Button>
      </div>
    </section>
  );
}

function FolderSection({ chat }: { chat: ChatState }) {
  const client = useChatClient();
  const { copied, copy } = useCopy();
  const [failure, setFailure] = useState("");
  const { folder } = chat;
  const branch = folder.branch;
  return (
    <section>
      <h3>Folder</h3>
      <div className="chat-pop-path">
        <PathText path={folder.path} />
        <IconButton
          label={copied ? "Copied" : "Copy path"}
          onClick={() => void copy("Path", folder.path)}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
      </div>
      {branch &&
        (branch.name ? (
          <p className="chat-pop-line">
            <GitBranch size={16} aria-hidden />
            {branch.kind === "detached" && <span>Detached at</span>}
            <code className="chat-mono">{branch.name}</code>
          </p>
        ) : (
          <small>Couldn’t read the branch.</small>
        ))}
      {folder.missing && <small>Not found on this computer</small>}
      {folder.managed && <small>Kept by ticketd for this Chat</small>}
      {!folder.missing && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void client.openFolder(chat.id).then(
                () => setFailure(""),
                (reason: unknown) =>
                  setFailure(
                    reason instanceof Error ? reason.message : String(reason),
                  ),
              )
            }
          >
            <FolderOpen aria-hidden />
            Open in {fileManagerName()}
          </Button>
        </div>
      )}
      {failure && <small role="alert">{failure}</small>}
    </section>
  );
}

/**
 * The header's one context button and its popover, the only place for the
 * Harness, Folder and Branch: the Project icon (else a folder), the folder's
 * name, the branch in mono, and a count only when other Chats share the
 * folder. Short of room the branch goes first, then the name.
 */
export function ChatContext({ chat }: { chat: ChatState }) {
  const { folder } = chat;
  const others = folder.shared_with.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-context=""
          aria-label={contextLabel(chat)}
        >
          <FolderLead chat={chat} />
          <span className="chat-context-name">{folderLabel(folder)}</span>
          {folder.missing && (
            <span className="chat-context-missing">missing</span>
          )}
          {folder.branch?.name && (
            <span className="chat-context-branch">
              <GitBranch aria-hidden />
              {/* Right-to-left puts the ellipsis at the start: the end of a
                  branch name tells branches apart. */}
              <span className="chat-mono">
                <bdo dir="ltr">{folder.branch.name}</bdo>
              </span>
            </span>
          )}
          {others > 0 && (
            <span className="chat-context-shared">
              <MessagesSquare aria-hidden />
              {others}
            </span>
          )}
          <ChevronDown aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Chat context">
        <div className="chat-pop">
          <HarnessSection chat={chat} />
          <FolderSection chat={chat} />
          {others > 0 && (
            <section>
              <h3>Other Chats here</h3>
              {folder.shared_with.map((title, index) => (
                <p key={index} className="chat-pop-line">
                  <span className="chat-pop-truncate">{title}</span>
                </p>
              ))}
            </section>
          )}
          {folder.project && (
            <section>
              <h3>Project</h3>
              <p className="chat-pop-line">
                <ProjectIcon project={folder.project} />
                <span>{folder.project.title}</span>
              </p>
            </section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
