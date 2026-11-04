import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { documents, type Document } from "./api";
import { DocumentNavigation, PlanNavigation } from "./navigation";

function DocumentSurface({
  capture,
  onClose,
  children,
}: {
  capture: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!capture)
    return <article className="document-workspace">{children}</article>;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="document-dialog inset-0 max-w-none translate-x-0 translate-y-0 sm:max-w-none md:inset-y-2 md:right-2 md:left-auto md:w-[min(560px,calc(100vw-16px))]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
function DocumentDate({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (
    value
  ) : (
    <time dateTime={value} title={value}>
      {date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}
type Snapshot = { title: string; body: string; suggestion: string | null };
function documentHasEditorFocus() {
  return (
    document.activeElement instanceof HTMLElement &&
    Boolean(
      document.activeElement.closest(
        "input, textarea, [contenteditable=true], .cm-content",
      ),
    )
  );
}
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
  onOpenGraph,
  children,
}: {
  initial: Document | null;
  onClose: () => void;
  currentTicket?: string | null;
  onOpenDocument?: (id: string) => void;
  onOpenTicket?: (reference: string) => void;
  onOpenPlan?: (id: string) => void;
  onOpenGraph?: (id: string) => void;
  children?: ReactNode;
}) {
  const [writing, setWriting] = useState(initial === null);
  const [linkTarget, setLinkTarget] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  const [creatingFromDocument, setCreatingFromDocument] = useState(false);
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
  const [status, setStatus] = useState(
    initial ? "Saved locally" : "Start writing. We’ll save as you go.",
  );
  const [savedDocument, setSavedDocument] = useState(initial);
  const [trashed, setTrashed] = useState(initial?.trashed ?? false);
  const [transitioning, setTransitioning] = useState(false);
  const transition = useRef<{ trashed: boolean; requestId: string } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const [external, setExternal] = useState<Snapshot | null>(null);
  const externalRef = useRef<Snapshot | null>(null);
  const draft = useRef<Snapshot>({ title, body, suggestion });
  const saved = useRef<Snapshot>({ title, body, suggestion: null });
  const id = useRef(initial?.id ?? null);
  const pending = useRef<Pending | null>(null);
  const saving = useRef(false);
  const ticketRequest = useRef<{ title: string; id: string } | null>(null);
  const creatingTicket = useRef(false);
  const closeRequested = useRef(false);
  const afterSave = useRef<(() => void) | null>(null);
  const finish = () => {
    const action = afterSave.current ?? close.current;
    afterSave.current = null;
    closeRequested.current = false;
    action();
  };
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
    if (saving.current || externalRef.current) return;
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
      setSavedDocument(result);
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
    const timer = window.setInterval(() => {
      if (!id.current || saving.current) return;
      void documents
        .show(id.current)
        .then((document) => {
          if (saving.current) return;
          setTrashed(document.trashed);
          setSavedDocument(document);
          const currentSuggestion = saved.current.suggestion;
          const link = currentSuggestion
            ? `[${currentSuggestion}](ticketd://ticket/${currentSuggestion})`
            : "";
          const hasLink = Boolean(
            currentSuggestion &&
            (document.body === link || document.body.endsWith(`\n\n${link}`)),
          );
          const next: Snapshot = {
            title: document.title ?? "",
            body: hasLink
              ? document.body.slice(0, -link.length).replace(/\n\n$/, "")
              : document.body,
            suggestion: hasLink ? currentSuggestion : null,
          };
          if (
            next.title === saved.current.title &&
            next.body === saved.current.body
          )
            return;
          const editing = documentHasEditorFocus();
          const titleDirty = draft.current.title !== saved.current.title;
          const bodyDirty =
            draft.current.body !== saved.current.body ||
            draft.current.suggestion !== saved.current.suggestion;
          const conflict =
            (titleDirty && next.title !== saved.current.title) ||
            (bodyDirty &&
              (next.body !== saved.current.body ||
                next.suggestion !== saved.current.suggestion));
          if (
            conflict ||
            (editing && !titleDirty && !bodyDirty) ||
            pending.current
          ) {
            // Preserve unrelated saved-field changes when the person chooses to
            // save over a conflicting field.
            if (titleDirty || bodyDirty) {
              if (!titleDirty) {
                draft.current = { ...draft.current, title: next.title };
                saved.current = { ...saved.current, title: next.title };
                setTitle(next.title);
              }
              if (!bodyDirty) {
                draft.current = {
                  ...draft.current,
                  body: next.body,
                  suggestion: next.suggestion,
                };
                saved.current = {
                  ...saved.current,
                  body: next.body,
                  suggestion: next.suggestion,
                };
                setBody(next.body);
                setSuggestion(next.suggestion);
              }
            }
            externalRef.current = next;
            setExternal(next);
            return;
          }
          const merged = {
            title: titleDirty ? draft.current.title : next.title,
            body: bodyDirty ? draft.current.body : next.body,
            suggestion: bodyDirty ? draft.current.suggestion : next.suggestion,
          };
          saved.current = next;
          draft.current = merged;
          if (!titleDirty) setTitle(merged.title);
          if (!bodyDirty) {
            setBody(merged.body);
            setSuggestion(merged.suggestion);
          }
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
    <DocumentSurface capture={!initial} onClose={requestClose}>
      <header>
        {initial ? (
          <h1>
            {title.trim() ||
              savedDocument?.heading ||
              initial.origin_brief?.trim() ||
              "Document"}
          </h1>
        ) : (
          <DialogTitle>Capture a thought</DialogTitle>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close and return"
          onClick={requestClose}
        >
          ×
        </Button>
      </header>
      {initial && (
        <div className="document-mode" aria-label="Document mode">
          <Button
            variant={writing ? "ghost" : "secondary"}
            onClick={() => setWriting(false)}
          >
            Read
          </Button>
          <Button
            variant={writing ? "secondary" : "ghost"}
            onClick={() => setWriting(true)}
          >
            Write
          </Button>
          <span role="status">{status}</span>
        </div>
      )}
      {(!initial || writing) && (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="document-title">Optional title</FieldLabel>
            <Input
              id="document-title"
              placeholder={initial?.origin_brief?.trim() || "Untitled"}
              readOnly={trashed || transitioning}
              value={title}
              onChange={(event) => {
                draft.current = { ...draft.current, title: event.target.value };
                setTitle(event.target.value);
              }}
            />
          </Field>
        </FieldGroup>
      )}
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
      {external && (
        <div role="alert">
          <p>Saved content changed while you were editing.</p>
          <Button
            variant="outline"
            onClick={() => {
              saved.current = external;
              draft.current = external;
              pending.current = null;
              externalRef.current = null;
              setExternal(null);
              setTitle(external.title);
              setBody(external.body);
              setSuggestion(null);
              setFailed(false);
              setStatus("Loaded saved content");
            }}
          >
            Reload saved content
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              saved.current = external;
              pending.current = null;
              externalRef.current = null;
              setExternal(null);
              void save();
            }}
          >
            Save over saved content
          </Button>
        </div>
      )}
      <div className="document-body">
        {!initial || writing ? (
          <LazyMarkdownEditor
            value={body}
            onChange={(value) => {
              draft.current = { ...draft.current, body: value };
              setBody(value);
            }}
            label="Your thought"
            readOnly={trashed || transitioning}
            autoFocus={!initial}
          />
        ) : (
          <DocumentNavigation.Provider
            value={
              onOpenDocument ? (id) => navigate(() => onOpenDocument(id)) : null
            }
          >
            <PlanNavigation.Provider
              value={onOpenPlan ? (id) => navigate(() => onOpenPlan(id)) : null}
            >
              <MarkdownDocument
                source={body}
                select={
                  onOpenTicket
                    ? (reference) => navigate(() => onOpenTicket(reference))
                    : undefined
                }
              />
            </PlanNavigation.Provider>
          </DocumentNavigation.Provider>
        )}
      </div>
      <aside className="document-rail">
        {initial && (
          <section aria-label="Document details">
            <h2>Document details</h2>
            <dl>
              <dt>Updated</dt>
              <dd>
                <DocumentDate
                  value={savedDocument?.updated_at ?? initial.updated_at}
                />
              </dd>
              <dt>Created</dt>
              <dd>
                <DocumentDate
                  value={savedDocument?.created_at ?? initial.created_at}
                />
              </dd>
              {initial.origin_ticket && (
                <>
                  <dt>Origin</dt>
                  <dd>
                    <Button
                      variant="link"
                      onClick={() =>
                        navigate(() => onOpenTicket?.(initial.origin_ticket!))
                      }
                    >
                      {initial.origin_ticket} · Activity details
                    </Button>
                  </dd>
                </>
              )}
              <dt>Visibility</dt>
              <dd>
                {initial.origin_brief && !initial.kept
                  ? "Activity details"
                  : "Documents"}
              </dd>
            </dl>
          </section>
        )}
        {children}
        {initial && onOpenGraph && (
          <Button
            variant="outline"
            onClick={() => navigate(() => onOpenGraph(initial.id))}
          >
            Context graph
          </Button>
        )}
        {(!initial || writing) && (
          <>
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
          </>
        )}
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
                      <DocumentNavigation.Provider
                        value={
                          onOpenDocument
                            ? (id) => navigate(() => onOpenDocument(id))
                            : null
                        }
                      >
                        <PlanNavigation.Provider
                          value={
                            onOpenPlan
                              ? (id) => navigate(() => onOpenPlan(id))
                              : null
                          }
                        >
                          <div className="document-passage">
                            <MarkdownDocument
                              source={link.passage}
                              select={
                                onOpenTicket
                                  ? (reference) =>
                                      navigate(() => onOpenTicket(reference))
                                  : undefined
                              }
                            />
                          </div>
                        </PlanNavigation.Provider>
                      </DocumentNavigation.Provider>
                    </li>
                  );
                }),
              )}
            </ul>
            {!creatingFromDocument && (
              <Button
                variant="outline"
                onClick={() => setCreatingFromDocument(true)}
              >
                Create ticket
              </Button>
            )}
            <div
              hidden={!creatingFromDocument}
              className="document-create-ticket"
            >
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
            </div>
          </section>
        )}
      </aside>
      <footer>
        {!initial && <span role="status">{status}</span>}
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
    </DocumentSurface>
  );
}
