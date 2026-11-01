import "./description.css";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { client, type Ticket } from "@/lib/api/client";

type Content = Pick<Ticket, "title" | "body">;
export function TicketEditor({
  ticket,
  onSaved,
  children,
  select,
  revision,
}: {
  ticket: Ticket;
  onSaved: (ticket: Ticket) => void;
  children?: ReactNode;
  select?: (reference: string) => void;
  revision?: number;
}) {
  const [draft, setDraft] = useState<Content>({
    title: ticket.title,
    body: ticket.body,
  });
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const fitTitle = () => {
      if (!title.clientWidth) return;
      title.style.height = "auto";
      title.style.height = `${title.scrollHeight}px`;
    };
    fitTitle();
    void document.fonts?.ready.then(fitTitle);
    document.fonts?.addEventListener("loadingdone", fitTitle);
    if (typeof ResizeObserver === "undefined")
      return () => document.fonts?.removeEventListener("loadingdone", fitTitle);
    let width = title.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      fitTitle();
    });
    observer.observe(title);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", fitTitle);
    };
  }, [draft.title]);
  const [saved, setSaved] = useState<Content>({
    title: ticket.title,
    body: ticket.body,
  });
  // "idle" until something is saved, so an untouched ticket doesn't say "Saved".
  const [state, setState] = useState<"idle" | "saved" | "pending" | "failed">(
    "idle",
  );
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [bodyMode, setBodyMode] = useState<"unopened" | "editing" | "reading">(
    "unopened",
  );
  const editingBody = bodyMode === "editing";
  const editButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const dirty = draft.title !== saved.title || draft.body !== saved.body;
  const titleDirty = draft.title !== saved.title;
  const bodyDirty = draft.body !== saved.body;
  const externalChange =
    (titleDirty && ticket.title !== saved.title) ||
    (bodyDirty && ticket.body !== saved.body);
  // Refresh untouched fields independently while retaining a draft in the other field.
  if (
    !saving &&
    ((!titleDirty && ticket.title !== saved.title) ||
      (!bodyDirty && ticket.body !== saved.body))
  ) {
    const content = {
      title: titleDirty ? saved.title : ticket.title,
      body: bodyDirty ? saved.body : ticket.body,
    };
    setSaved(content);
    setDraft({
      title: titleDirty ? draft.title : content.title,
      body: bodyDirty ? draft.body : content.body,
    });
  }

  useEffect(() => {
    if (!dirty || externalChange || inFlight.current || state === "failed")
      return;
    const timer = window.setTimeout(() => {
      inFlight.current = true;
      setSaving(true);
      setState("pending");
      const patch: { title?: string; body?: string } = {};
      if (draft.title !== saved.title) patch.title = draft.title;
      if (draft.body !== saved.body) patch.body = draft.body;
      void client
        .changeTicket(ticket.reference, patch)
        .then((result) => {
          setSaved({ title: result.title, body: result.body });
          setDraft((current) => ({
            title: current.title === draft.title ? result.title : current.title,
            body: current.body === draft.body ? result.body : current.body,
          }));
          onSaved(result);
          setError("");
          setState("saved");
        })
        .catch((reason: unknown) => {
          setError(String(reason));
          setState("failed");
        })
        .finally(() => {
          inFlight.current = false;
          setSaving(false);
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    draft,
    saved,
    dirty,
    externalChange,
    ticket.reference,
    onSaved,
    state,
    retry,
  ]);

  function edit(next: Content) {
    setDraft(next);
    setState("pending");
  }
  return (
    <div className="ticket-editor">
      {externalChange && dirty && (
        <p role="status">
          Saved content changed.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setDraft({ title: ticket.title, body: ticket.body });
              setSaved({ title: ticket.title, body: ticket.body });
              setState("saved");
            }}
          >
            Reload saved content
          </button>{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setSaved({ title: ticket.title, body: ticket.body });
              setState("pending");
            }}
          >
            Save my draft
          </button>
        </p>
      )}
      <label className="editor-title">
        <span className="sr-only">Title</span>
        <textarea
          ref={titleRef}
          aria-label="Title"
          rows={1}
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
        />
      </label>
      {children}
      <div className="editor-body">
        <div className="description-heading">
          <span id={`body-${ticket.id}`}>Description</span>
          {editingBody ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setBodyMode("reading");
                window.requestAnimationFrame(() => editButton.current?.focus());
              }}
            >
              Done editing
            </Button>
          ) : (
            <Button
              ref={editButton}
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setBodyMode("editing")}
            >
              Edit description
            </Button>
          )}
        </div>
        {bodyMode !== "unopened" && (
          <div hidden={!editingBody}>
            <LazyMarkdownEditor
              value={draft.body}
              onChange={(body) => edit({ ...draft, body })}
              label="Description"
              autoFocus={editingBody}
            />
          </div>
        )}
        {!editingBody &&
          (draft.body ? (
            <div
              className="markdown-preview description-document"
              onClick={(event) => {
                const target = event.target;
                if (
                  target instanceof Element &&
                  target.closest(
                    "a, button, input, select, textarea, summary, [role=button]",
                  )
                )
                  return;
                if (window.getSelection()?.toString()) return;
                setBodyMode("editing");
              }}
            >
              <MarkdownDocument
                source={draft.body}
                select={select}
                revision={revision}
              />
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="description-empty"
              onClick={() => setBodyMode("editing")}
            >
              Add a description…
            </Button>
          ))}
      </div>
      <p role="status" className="editor-save-state">
        {saving
          ? "Saving…"
          : dirty && state !== "failed"
            ? "Pending save"
            : state === "failed"
              ? "Save failed"
              : state === "saved"
                ? "Saved"
                : ""}
      </p>
      {state === "failed" && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setState("pending");
              setRetry((value) => value + 1);
            }}
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
