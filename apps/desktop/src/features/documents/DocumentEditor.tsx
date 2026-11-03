import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { documents, type Document } from "./api";

type Snapshot = { title: string; body: string; suggestion: string | null };
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
  onOpenPlan,
  children,
}: {
  initial: Document | null;
  onClose: () => void;
  currentTicket?: string | null;
  onOpenDocument?: (id: string) => void;
  onOpenTicket?: (reference: string) => void;
  onOpenPlan?: (id: string) => void;
  children?: ReactNode;
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
  const [trashed, setTrashed] = useState(initial?.trashed ?? false);
  const [transitioning, setTransitioning] = useState(false);
  const transition = useRef<{ trashed: boolean; requestId: string } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const draft = useRef<Snapshot>({ title, body, suggestion });
  const saved = useRef<Snapshot>({ title, body, suggestion: null });
  const id = useRef(initial?.id ?? null);
  const pending = useRef<Pending | null>(null);
  const saving = useRef(false);
  const ticketRequest = useRef<{ title: string; id: string } | null>(null);
  const creatingTicket = useRef(false);
  const closeRequested = useRef(false);
  const afterSave = useRef<(() => void) | null>(null);
  const finish = () => (afterSave.current ?? close.current)();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  const finishTransition = async () => {
    if (!transition.current || !id.current) return;
    setTransitioning(true);
    try {
      const result = await documents.setTrashed(
        id.current,
        transition.current.trashed,
        transition.current.requestId,
      );
      setTrashed(result.trashed);
      transition.current = null;
      setFailed(false);
      setStatus(result.trashed ? "Moved to Trash" : "Restored");
    } catch (error) {
      setFailed(true);
      setStatus(`Could not update Trash: ${String(error)}`);
    } finally {
      setTransitioning(false);
    }
  };
  const save = async () => {
    if (saving.current) return;
    const snapshot = draft.current;
    const titleChanged = snapshot.title !== saved.current.title;
    const bodyChanged =
      snapshot.body !== saved.current.body ||
      snapshot.suggestion !== saved.current.suggestion;
    if (!pending.current && !titleChanged && !bodyChanged) {
      if (transition.current) void finishTransition();
      else if (closeRequested.current) finish();
      return;
    }
    if (
      !pending.current &&
      !id.current &&
      !snapshot.title.trim() &&
      !snapshot.body.trim()
    ) {
      if (closeRequested.current) finish();
      return;
    }
    const request = pending.current ?? {
      id: id.current,
      title: snapshot.title.trim() ? snapshot.title : null,
      body:
        !id.current || bodyChanged
          ? snapshot.suggestion
            ? `${snapshot.body}${snapshot.body ? "\n\n" : ""}[${snapshot.suggestion}](ticketd://ticket/${snapshot.suggestion})`
            : snapshot.body
          : null,
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
      if (initial)
        void documents
          .links(initial.id)
          .then(setLinks)
          .catch((error: unknown) => setLinkError(String(error)));
      if (
        draft.current.title !== saved.current.title ||
        draft.current.body !== saved.current.body ||
        draft.current.suggestion !== saved.current.suggestion
      )
        void save();
      else if (transition.current) void finishTransition();
      else if (closeRequested.current) finish();
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
  }, [title, body, suggestion]);
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
        draft.current.body !== saved.current.body ||
        draft.current.suggestion !== saved.current.suggestion
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
            draft.current.body !== saved.current.body ||
            draft.current.suggestion !== saved.current.suggestion
          )
            return;
          setTrashed(document.trashed);
          const currentSuggestion = draft.current.suggestion;
          const link = currentSuggestion
            ? `[${currentSuggestion}](ticketd://ticket/${currentSuggestion})`
            : "";
          const hasLink =
            currentSuggestion &&
            (document.body === link || document.body.endsWith(`\n\n${link}`));
          const next = {
            title: document.title ?? "",
            body: hasLink
              ? document.body
                  .slice(0, document.body.length - link.length)
                  .replace(/\n\n$/, "")
              : document.body,
            suggestion: hasLink ? currentSuggestion : null,
          };
          if (!hasLink && currentSuggestion) setSuggestion(null);
          saved.current = next;
          draft.current = next;
          setTitle(next.title);
          setBody(next.body);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const navigate = (action: () => void) => {
    afterSave.current = action;
    closeRequested.current = true;
    void save();
  };
  const requestClose = () => {
    afterSave.current = null;
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
              readOnly={trashed || transitioning}
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
                draft.current = { ...draft.current, suggestion: null };
                setSuggestion(null);
              }}
            >
              Remove
            </Button>
          </p>
        )}
        {children}
        <LazyMarkdownEditor
          value={body}
          onChange={(value) => {
            draft.current = { ...draft.current, body: value };
            setBody(value);
          }}
          label="Your thought"
          readOnly={trashed || transitioning}
          autoFocus
        />
        <Field>
          <FieldLabel htmlFor="link-target">Link target</FieldLabel>
          <Input
            id="link-target"
            placeholder="Ticket reference or Document ID"
            disabled={trashed || transitioning}
            value={linkTarget}
            onChange={(event) => setLinkTarget(event.target.value)}
          />
        </Field>
        <Button
          disabled={trashed || transitioning || !linkTarget.trim()}
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
            {links.some((group) => group.length === 100) && (
              <p>Showing the first 100 items in each direction.</p>
            )}
            <ul>
              {links.flatMap((group, direction) =>
                group.map((link) => {
                  const kind =
                    direction === 0 ? link.target_kind : link.source_kind;
                  const target =
                    direction === 0 ? link.target_id : link.source_id;
                  const isTrashed =
                    direction === 0 ? link.target_trashed : link.source_trashed;
                  const label =
                    direction === 0 ? link.target_label : link.source_label;
                  return (
                    <li key={`${direction}-${target}-${link.passage}`}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (kind === "document")
                            navigate(() => onOpenDocument?.(target));
                          else if (kind === "ticket")
                            navigate(() => onOpenTicket?.(label));
                          else if (kind === "plan")
                            navigate(() => onOpenPlan?.(target));
                        }}
                      >
                        {label}
                        {isTrashed ? " (Trash)" : ""}
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
              disabled={trashed || transitioning || !ticketTitle.trim()}
              onClick={() => {
                if (creatingTicket.current) return;
                if (
                  !ticketRequest.current ||
                  ticketRequest.current.title !== ticketTitle
                )
                  ticketRequest.current = {
                    title: ticketTitle,
                    id: crypto.randomUUID(),
                  };
                creatingTicket.current = true;
                void documents
                  .createTicket(
                    initial.id,
                    ticketTitle,
                    ticketRequest.current.id,
                  )
                  .then((ticket) =>
                    navigate(() => onOpenTicket?.(ticket.reference)),
                  )
                  .catch((error: unknown) => setLinkError(String(error)))
                  .finally(() => {
                    creatingTicket.current = false;
                  });
              }}
            >
              Create ticket
            </Button>
          </section>
        )}
        <footer>
          <span role="status">{status}</span>
          {trashed && <span>This Document is in Trash.</span>}
          {initial && (
            <Button
              variant="outline"
              disabled={transitioning}
              onClick={() => {
                transition.current = {
                  trashed: !trashed,
                  requestId: crypto.randomUUID(),
                };
                void save();
              }}
            >
              {trashed ? "Restore" : "Move to Trash"}
            </Button>
          )}
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
