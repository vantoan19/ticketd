import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { documents, type Document } from "./api";

type Snapshot = { title: string; body: string };
type Pending = {
  id: string | null;
  title: string | null;
  body: string | null;
  titleChanged: boolean;
  requestId: string;
  snapshot: Snapshot;
};
export function DocumentEditor({
  initial,
  onClose,
  currentTicket,
  onOpenDocument,
  onOpenTicket,
}: {
  initial: Document | null;
  onClose: () => void;
  currentTicket?: string | null;
  onOpenDocument?: (id: string) => void;
  onOpenTicket?: (reference: string) => void;
}) {
  const [linkTarget, setLinkTarget] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  const [links, setLinks] = useState<
    Awaited<ReturnType<typeof documents.links>>
  >([[], []]);
  const [linkError, setLinkError] = useState("");
  const [suggestion, setSuggestion] = useState(currentTicket ?? null);
  useEffect(() => {
    if (initial)
      void documents
        .links(initial.id)
        .then(setLinks)
        .catch((error: unknown) => setLinkError(String(error)));
  }, [initial]);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [status, setStatus] = useState("Start writing. We’ll save as you go.");
  const [failed, setFailed] = useState(false);
  const draft = useRef<Snapshot>({ title, body });
  const saved = useRef<Snapshot>({ title, body });
  const id = useRef(initial?.id ?? null);
  const pending = useRef<Pending | null>(null);
  const saving = useRef(false);
  const closeRequested = useRef(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  const save = async () => {
    if (saving.current) return;
    let snapshot = draft.current;
    if (
      !id.current &&
      suggestion &&
      snapshot.title.trim() &&
      !snapshot.body.trim()
    ) {
      snapshot = {
        ...snapshot,
        body: `[${suggestion}](ticketd://ticket/${suggestion})`,
      };
      draft.current = snapshot;
      setBody(snapshot.body);
    }
    const titleChanged = snapshot.title !== saved.current.title;
    const bodyChanged = snapshot.body !== saved.current.body;
    if (!pending.current && !titleChanged && !bodyChanged) {
      if (closeRequested.current) close.current();
      return;
    }
    if (
      !pending.current &&
      !id.current &&
      !snapshot.title.trim() &&
      !snapshot.body.trim()
    ) {
      if (closeRequested.current) close.current();
      return;
    }
    const request = pending.current ?? {
      id: id.current,
      title: snapshot.title.trim() ? snapshot.title : null,
      body: !id.current || bodyChanged ? snapshot.body : null,
      titleChanged,
      requestId: crypto.randomUUID(),
      snapshot,
    };
    pending.current = request;
    saving.current = true;
    setStatus("Saving…");
    setFailed(false);
    try {
      const result = await documents.save(
        request.id,
        request.title,
        request.body,
        request.titleChanged,
        request.requestId,
      );
      id.current = result.id;
      saved.current = request.snapshot;
      pending.current = null;
      saving.current = false;
      setStatus("Saved locally");
      if (
        draft.current.title !== saved.current.title ||
        draft.current.body !== saved.current.body
      )
        void save();
      else if (closeRequested.current) close.current();
    } catch (error) {
      saving.current = false;
      closeRequested.current = false;
      setFailed(true);
      setStatus(`Could not save: ${String(error)}`);
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => void saveRef.current(), 400);
    return () => window.clearTimeout(timer);
  }, [title, body]);
  useEffect(() => {
    // Replacing rich editor content while typing can move its selection or focus.
    const editing = () =>
      document.activeElement instanceof HTMLElement &&
      Boolean(
        document.activeElement.closest(
          "input, textarea, [contenteditable=true], .cm-content",
        ),
      );
    const timer = window.setInterval(() => {
      if (
        !id.current ||
        editing() ||
        saving.current ||
        pending.current ||
        draft.current.title !== saved.current.title ||
        draft.current.body !== saved.current.body
      )
        return;
      void documents
        .show(id.current)
        .then((document) => {
          if (
            editing() ||
            saving.current ||
            pending.current ||
            draft.current.title !== saved.current.title ||
            draft.current.body !== saved.current.body
          )
            return;
          const next = { title: document.title ?? "", body: document.body };
          saved.current = next;
          draft.current = next;
          setTitle(next.title);
          setBody(next.body);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const requestClose = () => {
    closeRequested.current = true;
    void save();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        className="document-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <header>
          <DialogTitle>
            {initial ? "Document" : "Capture a thought"}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close and return"
            onClick={requestClose}
          >
            ×
          </Button>
        </header>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="document-title">Optional title</FieldLabel>
            <Input
              id="document-title"
              placeholder="Untitled"
              value={title}
              onChange={(event) => {
                draft.current = { ...draft.current, title: event.target.value };
                setTitle(event.target.value);
              }}
            />
          </Field>
        </FieldGroup>
        {suggestion && (
          <p>
            Connected to {suggestion}{" "}
            <Button
              variant="ghost"
              aria-label={`Remove connection to ${suggestion}`}
              onClick={() => {
                const link = `[${suggestion}](ticketd://ticket/${suggestion})`;
                const next =
                  draft.current.body === link
                    ? ""
                    : draft.current.body.replace(`\n\n${link}`, "");
                draft.current = { ...draft.current, body: next };
                setBody(next);
                setSuggestion(null);
              }}
            >
              Remove
            </Button>
          </p>
        )}
        <LazyMarkdownEditor
          value={body}
          onChange={(value) => {
            const link = suggestion
              ? `[${suggestion}](ticketd://ticket/${suggestion})`
              : "";
            const next =
              suggestion &&
              value.trim() &&
              !draft.current.body &&
              !value.includes(link)
                ? `${value}\n\n${link}`
                : value;
            draft.current = { ...draft.current, body: next };
            setBody(next);
          }}
          label="Your thought"
          autoFocus
        />
        <Field>
          <FieldLabel htmlFor="link-target">Link target</FieldLabel>
          <Input
            id="link-target"
            placeholder="Ticket reference or Document ID"
            value={linkTarget}
            onChange={(event) => setLinkTarget(event.target.value)}
          />
        </Field>
        <Button
          disabled={!linkTarget.trim()}
          variant="outline"
          onClick={() =>
            void documents
              .linkMarkdown(linkTarget.trim())
              .then((link) => {
                const next = draft.current.body
                  ? `${draft.current.body}\n\n${link}`
                  : link;
                draft.current = { ...draft.current, body: next };
                setBody(next);
                setLinkTarget("");
                setLinkError("");
              })
              .catch((error: unknown) => setLinkError(String(error)))
          }
        >
          Insert link
        </Button>
        {linkError && <p role="alert">{linkError}</p>}
        {initial && (
          <section aria-label="Connected items">
            <h2>Connected items</h2>
            <ul>
              {links.flatMap((group, direction) =>
                group.map((link) => {
                  const kind =
                    direction === 0 ? link.target_kind : link.source_kind;
                  const target =
                    direction === 0 ? link.target_id : link.source_id;
                  const label =
                    direction === 0 ? link.target_label : link.source_label;
                  return (
                    <li key={`${direction}-${target}-${link.passage}`}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (kind === "document") onOpenDocument?.(target);
                          else if (kind === "ticket") onOpenTicket?.(label);
                        }}
                      >
                        {label}
                      </Button>
                      <p>{link.passage}</p>
                    </li>
                  );
                }),
              )}
            </ul>
            <Field>
              <FieldLabel htmlFor="ticket-from-document">
                New ticket title
              </FieldLabel>
              <Input
                id="ticket-from-document"
                value={ticketTitle}
                onChange={(event) => setTicketTitle(event.target.value)}
              />
            </Field>
            <Button
              disabled={!ticketTitle.trim()}
              onClick={() =>
                void documents
                  .createTicket(initial.id, ticketTitle, crypto.randomUUID())
                  .then((ticket) => onOpenTicket?.(ticket.reference))
                  .catch((error: unknown) => setLinkError(String(error)))
              }
            >
              Create ticket
            </Button>
          </section>
        )}
        <footer>
          <span role="status">{status}</span>
          {failed && (
            <Button variant="outline" onClick={() => void save()}>
              Retry
            </Button>
          )}
          <Button variant="outline" onClick={requestClose}>
            Back to work
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
