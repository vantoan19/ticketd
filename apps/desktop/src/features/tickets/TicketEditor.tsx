import "./description.css";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { client, type Ticket } from "@/lib/api/client";

const extensions = [markdown(), EditorView.lineWrapping];

type Content = Pick<Ticket, "title" | "body">;
export function TicketEditor({
  ticket,
  onSaved,
  children,
}: {
  ticket: Ticket;
  onSaved: (ticket: Ticket) => void;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<Content>({
    title: ticket.title,
    body: ticket.body,
  });
  const [saved, setSaved] = useState<Content>({
    title: ticket.title,
    body: ticket.body,
  });
  const [state, setState] = useState<"saved" | "pending" | "failed">("saved");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [editingBody, setEditingBody] = useState(false);
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
    <div className="mt-3">
      <p className="editor-reference">
        {ticket.reference} · {ticket.status}
      </p>
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
          aria-label="Title"
          rows={2}
          className="rounded border border-neutral-400 bg-white p-2"
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
        />
      </label>
      <div className="editor-body">
        <div className="description-heading">
          <span id={`body-${ticket.id}`}>Description</span>
          {editingBody ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setEditingBody(false);
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
              onClick={() => setEditingBody(true)}
            >
              Edit description
            </Button>
          )}
        </div>
        {editingBody ? (
          <CodeMirror
            value={draft.body}
            onChange={(body) => edit({ ...draft, body })}
            extensions={extensions}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
            }}
            indentWithTab={false}
            autoFocus
            aria-labelledby={`body-${ticket.id}`}
          />
        ) : draft.body ? (
          <div
            className="markdown-preview description-document"
            onClick={(event) => {
              const target = event.target;
              if (
                target instanceof Element &&
                target.closest(
                  "a, button, input, select, textarea, [role=button]",
                )
              )
                return;
              if (window.getSelection()?.toString()) return;
              setEditingBody(true);
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {draft.body}
            </ReactMarkdown>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="description-empty"
            onClick={() => setEditingBody(true)}
          >
            Add a description…
          </Button>
        )}
      </div>
      <p role="status" className="my-2">
        {saving
          ? "Saving…"
          : dirty && state !== "failed"
            ? "Pending save"
            : state === "failed"
              ? "Save failed"
              : "Saved"}
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
      {children}
    </div>
  );
}
