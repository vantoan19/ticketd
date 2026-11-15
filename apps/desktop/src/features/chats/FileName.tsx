import { useContext, useState } from "react";
import { ChatError } from "@/features/chats/client";
import { ChatFilesContext } from "@/features/chats/files";
import { Tooltip } from "@/components/ui/tooltip";

/** How many characters of a name always show, so its extension survives. */
const TAIL = 12;

/**
 * A file a step named, in mono. The name is the button: it opens the file in the
 * system's default app. Short of room it truncates in the middle and keeps its
 * end, so the extension stays. A file that is gone is plain text.
 */
export function FileName({
  path,
  shown,
  onFailed,
}: {
  /** Relative to the Chat's folder. */
  path: string;
  shown: string;
  onFailed: (message: string) => void;
}) {
  const { open } = useContext(ChatFilesContext);
  const [gone, setGone] = useState(false);
  const split = Math.max(0, shown.length - TAIL);
  const text = (
    <>
      <span className="chat-file-head">{shown.slice(0, split)}</span>
      <span className="chat-file-tail">{shown.slice(split)}</span>
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
              onFailed(`${shown} is no longer in this folder.`);
            } else
              onFailed(
                reason instanceof Error ? reason.message : String(reason),
              );
          },
        )
      }
    >
      {text}
    </button>
    </Tooltip>
  );
}
