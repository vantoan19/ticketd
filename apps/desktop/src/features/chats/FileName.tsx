import { failureText } from "@/lib/api/describe-failure";
import { useContext, useState } from "react";
import { ChatError } from "@/features/chats/client";
import { ChatFilesContext, splitPath } from "@/features/chats/files";
import { Tooltip } from "@/components/ui/tooltip";

/** How many characters of a name always show, so its extension survives. */
const TAIL = 12;
/** A path in a step row is cut shorter than a changed file's, so two fit on a line. */
const STEP_PATH = 36;

/** A path as its muted folder, cut from the start, then its name in ink. */
export function PathText({ path, max }: { path: string; max?: number }) {
  const { folder, name } = splitPath(path, max);
  return (
    <>
      {folder && <span className="chat-path-dir">{folder}</span>}
      {name}
    </>
  );
}

/** A folder or file a step named, in mono, with its full path in the tooltip. */
export function PathCode({ path }: { path: string }) {
  return (
    <Tooltip content={path}>
      <code className="chat-path">
        <PathText path={path} max={STEP_PATH} />
      </code>
    </Tooltip>
  );
}

/**
 * A file a step named, in mono. The name is the button: it opens the file in the
 * system's default app. Its folder, cut from the start, is muted before it. Short of
 * room the folder gives way first, then the name truncates in the middle and keeps
 * its end, so the extension stays. A file that is gone is plain text.
 */
export function FileName({
  path,
  onFailed,
}: {
  /** Relative to the Chat's folder. */
  path: string;
  onFailed: (message: string) => void;
}) {
  const { open } = useContext(ChatFilesContext);
  const [gone, setGone] = useState(false);
  const { folder, name } = splitPath(path, STEP_PATH);
  const split = Math.max(0, name.length - TAIL);
  const text = (
    <>
      {folder && <span className="chat-path-dir">{folder}</span>}
      <span className="chat-file-head">{name.slice(0, split)}</span>
      <span className="chat-file-tail">{name.slice(split)}</span>
    </>
  );
  if (!open || gone)
    return (
      <Tooltip content={path}>
        <code className="chat-file-name">{text}</code>
      </Tooltip>
    );
  return (
    <Tooltip content={path}>
      <button
        type="button"
        className="chat-file-name"
        aria-label={`Open ${path}`}
        onClick={() =>
          void open(path).then(
            () => onFailed(""),
            (reason: unknown) => {
              if (reason instanceof ChatError && reason.code === "gone") {
                setGone(true);
                onFailed(`${name} is no longer in this folder.`);
              } else onFailed(failureText(reason, `open ${name}`));
            },
          )
        }
      >
        {text}
      </button>
    </Tooltip>
  );
}
