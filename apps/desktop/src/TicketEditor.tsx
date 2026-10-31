import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { client, type Ticket } from "./client";

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
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const dirty = draft.title !== saved.title || draft.body !== saved.body;
  const externalChange =
    ticket.title !== saved.title || ticket.body !== saved.body;
  // Adopt fresh content only while there is no draft to protect.
  if (externalChange && !dirty && !saving) {
    const content = { title: ticket.title, body: ticket.body };
    setSaved(content);
    setDraft(content);
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
          rows={2}
          className="rounded border border-neutral-400 bg-white p-2"
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
        />
      </label>
      {children}
      <div className="editor-body">
        <span id={`body-${ticket.id}`}>
          Description <small>Markdown supported</small>
        </span>
        <CodeMirror
          value={draft.body}
          onChange={(body) => edit({ ...draft, body })}
          extensions={extensions}
          indentWithTab={false}
          aria-labelledby={`body-${ticket.id}`}
        />
      </div>
      <p role="status" className="my-2">
        {dirty && state !== "failed"
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
      <details className="detail-disclosure">
        <summary>Preview</summary>
        <div className="markdown-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {draft.body}
          </ReactMarkdown>
        </div>
      </details>
    </div>
  );
}
