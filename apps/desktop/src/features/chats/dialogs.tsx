import { useId, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HistorySelection } from "@/features/chats/client";

type Choice = "last_response" | "last_messages" | "all" | "picked";
const RECENT = 6;

/**
 * "Resume in a fresh session": the same Chat continues with a new harness
 * session, started with history the person chooses. Never opened or submitted
 * on its own.
 */
export function ResumeDialog({
  open,
  onOpenChange,
  harness,
  messageCount,
  onResume,
  onPickMessages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  harness: string;
  messageCount: number;
  onResume: (history: HistorySelection) => Promise<void>;
  /** "Let me pick messages…" hands over to the transcript's pick mode. */
  onPickMessages: () => void;
}) {
  const [choice, setChoice] = useState<Choice>("last_response");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recent = Math.min(RECENT, messageCount);
  const choices: { id: Choice; label: string; hint?: string }[] = [
    {
      id: "last_response",
      label: "The last response",
      hint: "Enough for most follow-ups",
    },
    { id: "last_messages", label: `The last ${recent} messages` },
    {
      id: "all",
      label: "The whole conversation",
      hint: `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
    },
    { id: "picked", label: "Let me pick messages…" },
  ];
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Resume in a fresh session"
      primaryLabel="Resume"
      blockedReason={null}
      busy={busy}
      onSubmit={() => {
        if (choice === "picked") {
          onOpenChange(false);
          onPickMessages();
          return;
        }
        setBusy(true);
        onResume(
          choice === "last_messages"
            ? { kind: choice, count: recent }
            : { kind: choice },
        ).then(
          () => {
            setBusy(false);
            onOpenChange(false);
          },
          (reason: unknown) => {
            setBusy(false);
            setError(String(reason));
          },
        );
      }}
    >
      <p className="chat-dialog-text">
        This Chat continues with a new {harness} session. Choose the history to
        give it.
      </p>
      <fieldset
        className="chat-radios"
        role="radiogroup"
        aria-label="History to give the new session"
      >
        {choices.map((item) => (
          <label key={item.id} className="chat-radio">
            <input
              type="radio"
              name="chat-resume-history"
              checked={choice === item.id}
              onChange={() => setChoice(item.id)}
            />
            <span>
              {item.label}
              {item.hint && <small>{item.hint}</small>}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="chat-fine">
        Linked tickets and Documents are read fresh. Nothing you sent before is
        sent again.
      </p>
      {error && (
        <p className="chat-fine" role="alert">
          Could not resume: {error}
        </p>
      )}
    </DialogShell>
  );
}

/** A Document title suggested from the response's first line. */
function suggestedTitle(text: string) {
  const line = text.split("\n").find((value) => value.trim()) ?? "";
  return line.replace(/^[#>*\-\s]+/, "").slice(0, 80);
}

/** Saves one response through ordinary Document creation; nothing else is copied. */
export function SaveDocumentDialog({
  response,
  onClose,
  onSave,
}: {
  response: { id: string; text: string };
  onClose: () => void;
  onSave: (responseId: string, title: string) => Promise<void>;
}) {
  const id = useId();
  const [title, setTitle] = useState(() => suggestedTitle(response.text));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Save as Document"
      primaryLabel="Save"
      blockedReason={title.trim() ? null : "Give the Document a title."}
      busy={busy}
      onSubmit={() => {
        setBusy(true);
        onSave(response.id, title.trim()).then(onClose, (reason: unknown) => {
          setBusy(false);
          setError(String(reason));
        });
      }}
    >
      <div className="flex w-full flex-col gap-2">
        <Label htmlFor={id}>Title</Label>
        <Input
          id={id}
          value={title}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <p className="chat-fine">
        Saves this one response. The rest of the Chat isn’t copied.
      </p>
      {error && (
        <p className="chat-fine" role="alert">
          Could not save: {error}
        </p>
      )}
    </DialogShell>
  );
}
