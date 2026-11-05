import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, MoreHorizontal, Pin, X } from "lucide-react";
import { client } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { documentLinkMarkdown } from "./document-link";
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
const plain = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** A derived heading repeats the body's first line; the reader shows it once, as the heading. */
function withoutDerivedHeading(body: string, title: string, heading?: string) {
  if (title.trim() || !heading) return body;
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim());
  const line = first < 0 ? "" : (lines[first] ?? "");
  const want = plain(heading);
  if (!want || !plain(line).startsWith(want.slice(0, 120))) return body;
  return lines
    .slice(first + 1)
    .join("\n")
    .replace(/^\s*\n/, "");
}
/** The core stores a whitespace-only title as NULL; the saved baseline must match what it stored. */
const storedTitle = (title: string) => (title.trim() ? title : "");
type Pending = {
  id: string | null;
  title: string | null;
  body: string | null;
  titleChanged: boolean;
  requestId: string;
  snapshot: Snapshot;
  /** The stored revision this save was based on; the core rejects it if that moved on. */
  revision: string | null;
};
export function DocumentEditor({
  initial,
  onClose,
  currentTicket,
  onOpenDocument,
  onOpenTicket,
  onOpenPlan,
  onOpenGraph,
  active = true,
  pinned = false,
  onTogglePin,
  children,
}: {
  initial: Document | null;
  onClose: () => void;
  currentTicket?: string | null;
  onOpenDocument?: (id: string) => void;
  onOpenTicket?: (reference: string) => void;
  onOpenPlan?: (id: string) => void;
  onOpenGraph?: (id: string) => void;
  /** False while the Documents view is hidden: stop polling for outside changes. */
  active?: boolean;
  /** Reader header pin toggle; omitted when the host cannot pin. */
  pinned?: boolean;
  onTogglePin?: () => void;
  children?: ReactNode | ((state: { trashed: boolean }) => ReactNode);
}) {
  const [writing, setWriting] = useState(initial === null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ticketTitle, setTicketTitle] = useState("");
  const [creatingFromDocument, setCreatingFromDocument] = useState(false);
  const [links, setLinks] = useState<
    Awaited<ReturnType<typeof documents.links>>
  >([[], []]);
  const [linkError, setLinkError] = useState("");
  const [suggestion, setSuggestion] = useState(currentTicket ?? null);
  const linksKey = useRef("");
  const refreshLinks = () => {
    if (initial)
      void documents
        .links(initial.id)
        .then((next) => {
          const key = JSON.stringify(next);
          if (key === linksKey.current) return;
          linksKey.current = key;
          setLinks(next);
        })
        .catch((error: unknown) => setLinkError(String(error)));
  };
  const refreshLinksRef = useRef(refreshLinks);
  useEffect(() => {
    refreshLinksRef.current = refreshLinks;
  });
  useEffect(() => {
    refreshLinksRef.current();
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
  const [failureDetail, setFailureDetail] = useState("");
  const [failedTrash, setFailedTrash] = useState(false);
  // Editor state model. A Trash/Restore click is a one-shot intent: it is queued in
  // `transition` until the draft is saved, and dropped (remembered in `failedTransition`
  // for the Retry button only) as soon as anything fails, so autosave never replays it.
  const failedTransition = useRef<{
    trashed: boolean;
    requestId: string;
  } | null>(null);
  // Mirrors `trashed` for async callbacks. A Document in Trash cannot be written to.
  const trashedRef = useRef(initial?.trashed ?? false);
  const applyTrashed = (value: boolean) => {
    trashedRef.current = value;
    setTrashed(value);
  };
  const [external, setExternal] = useState<Snapshot | null>(null);
  const externalRef = useRef<Snapshot | null>(null);
  const draft = useRef<Snapshot>({ title, body, suggestion });
  const saved = useRef<Snapshot>({ title, body, suggestion: null });
  const id = useRef(initial?.id ?? null);
  const pending = useRef<Pending | null>(null);
  const saving = useRef(false);
  // `updated_at` of the stored Document as last loaded or saved here.
  const revision = useRef<string | null>(initial?.updated_at ?? null);
  const externalRevision = useRef<string | null>(null);
  const lastVersion = useRef<string | null>(
    initial ? `${initial.updated_at}|${initial.trashed}` : null,
  );
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
      applyTrashed(result.trashed);
      lastVersion.current = `${result.updated_at}|${result.trashed}`;
      transition.current = null;
      failedTransition.current = null;
      setFailed(false);
      setStatus(result.trashed ? "Moved to Trash" : "Restored");
      // A draft kept while the Document was in Trash can be saved now.
      if (!result.trashed) void save();
    } catch (error) {
      failedTransition.current = transition.current;
      transition.current = null;
      setFailed(true);
      setFailedTrash(true);
      setFailureDetail(String(error));
      setStatus("Not saved");
    } finally {
      setTransitioning(false);
    }
  };
  const save = async () => {
    if (saving.current || externalRef.current) return;
    if (trashedRef.current && id.current) {
      // Writes to a Document in Trash fail; don't let that block Restore or closing.
      if (closeRequested.current) finish();
      return;
    }
    const snapshot = draft.current;
    const titleChanged = storedTitle(snapshot.title) !== saved.current.title;
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
      revision: revision.current,
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
        request.revision,
        request.requestId,
      );
      id.current = result.id;
      revision.current = result.updated_at;
      lastVersion.current = `${result.updated_at}|${result.trashed}`;
      setSavedDocument(result);
      saved.current = {
        ...request.snapshot,
        title: storedTitle(request.snapshot.title),
      };
      pending.current = null;
      saving.current = false;
      setStatus("Saved locally");
      refreshLinks();
      if (
        storedTitle(draft.current.title) !== saved.current.title ||
        draft.current.body !== saved.current.body ||
        draft.current.suggestion !== saved.current.suggestion
      )
        void save();
      else if (transition.current) void finishTransition();
      else if (closeRequested.current) finish();
    } catch (error) {
      saving.current = false;
      closeRequested.current = false;
      afterSave.current = null;
      transition.current = null;
      if (String(error).includes("changed elsewhere") && id.current) {
        // The stored Document moved on since it was loaded: keep the draft and let
        // the conflict notice decide. If nothing differs, retry on the new revision.
        try {
          const latest = await documents.show(id.current);
          pending.current = null;
          if (reconcile(latest)) {
            setStatus("Saved locally");
            void save();
          } else {
            setFailed(false);
            setStatus("Not saved");
          }
          return;
        } catch {
          /* Fall through to the ordinary failure below. */
        }
      }
      setFailed(true);
      setFailedTrash(false);
      setFailureDetail(String(error));
      setStatus("Not saved");
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
  /**
   * Fold the stored Document into the editor. Returns true when it was settled (nothing
   * to resolve, or merged without touching the draft) and false when an outside change
   * conflicts with unsaved edits and the notice is showing.
   */
  const reconcile = (document: Document) => {
    applyTrashed(document.trashed);
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
    const settle = () => {
      revision.current = document.updated_at;
      // A resolved or merged outside change always clears the notice.
      externalRef.current = null;
      setExternal(null);
    };
    if (
      next.title === saved.current.title &&
      next.body === saved.current.body
    ) {
      settle();
      return true;
    }
    const titleDirty = storedTitle(draft.current.title) !== saved.current.title;
    const bodyDirty =
      draft.current.body !== saved.current.body ||
      draft.current.suggestion !== saved.current.suggestion;
    const conflict =
      (titleDirty && next.title !== saved.current.title) ||
      (bodyDirty &&
        (next.body !== saved.current.body ||
          next.suggestion !== saved.current.suggestion));
    if (conflict || pending.current) {
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
      externalRevision.current = document.updated_at;
      setExternal(next);
      return false;
    }
    // Nothing unsaved is at risk: refresh silently, keeping any unrelated dirty field.
    draft.current = {
      title: titleDirty ? draft.current.title : next.title,
      body: bodyDirty ? draft.current.body : next.body,
      suggestion: bodyDirty ? draft.current.suggestion : next.suggestion,
    };
    saved.current = next;
    settle();
    if (!titleDirty) setTitle(next.title);
    if (!bodyDirty) {
      setBody(next.body);
      setSuggestion(next.suggestion);
    }
    return true;
  };
  const reconcileRef = useRef(reconcile);
  useEffect(() => {
    reconcileRef.current = reconcile;
  });
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (!id.current || saving.current) return;
      // Links change when other Documents or tickets are edited, not only this one.
      refreshLinksRef.current();
      const polled = id.current;
      void documents
        .version(polled)
        .then(async (version) => {
          // Only fetch the body when the stored Document actually changed.
          if (version.join("|") === lastVersion.current) return;
          const document = await documents.show(polled);
          if (saving.current) return;
          // Remembered only once resolved: a deferred conflict must be re-checked next poll.
          if (reconcileRef.current(document))
            lastVersion.current = version.join("|");
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active]);
  // While the conflict notice is up, clicks that would leave or Trash the Document are
  // ignored (not queued), so they cannot fire later after the person resolves it.
  const navigate = (action: () => void) => {
    if (externalRef.current) return;
    afterSave.current = action;
    closeRequested.current = true;
    void save();
  };
  const requestClose = () => {
    if (externalRef.current) return;
    afterSave.current = null;
    closeRequested.current = true;
    void save();
  };
  const startTransition = (next: { trashed: boolean; requestId: string }) => {
    if (externalRef.current) return;
    transition.current = next;
    // Restore doesn't wait for the draft: it can't be saved while in Trash.
    if (trashedRef.current) void finishTransition();
    else void save();
  };
  const toggleTrash = () =>
    startTransition({ trashed: !trashed, requestId: crypto.randomUUID() });
  const retry = () => {
    if (failedTrash && failedTransition.current)
      startTransition(failedTransition.current);
    else void save();
  };
  const locked = trashed || transitioning;
  const capture = !initial;
  const heading =
    title.trim() ||
    savedDocument?.heading ||
    initial?.origin_brief?.trim() ||
    "Document";
  const titleField = (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="document-title">Optional title</FieldLabel>
        <Input
          id="document-title"
          placeholder={
            capture
              ? "Add a title (optional)"
              : initial.origin_brief?.trim() || "Untitled"
          }
          readOnly={locked}
          value={title}
          onChange={(event) => {
            draft.current = { ...draft.current, title: event.target.value };
            setTitle(event.target.value);
          }}
        />
      </Field>
    </FieldGroup>
  );
  const statusLine = (
    <span role="status" className="document-status">
      {status === "Saved locally" && <Check aria-hidden="true" />}
      {status}
    </span>
  );
  const saveError = failed && (
    <div role="alert" className="document-save-error">
      <p>
        {failedTrash
          ? "We couldn’t update Trash. Nothing was lost."
          : "We couldn’t save your changes. Your draft is still here."}
      </p>
      <Button onClick={retry}>Retry</Button>
      {failureDetail && (
        <details>
          <summary>Details</summary>
          <pre>{failureDetail}</pre>
        </details>
      )}
    </div>
  );
  const connected = groupConnections(links);
  return (
    <DocumentSurface capture={capture} onClose={requestClose}>
      <div className="document-main">
        {trashed && (
          <div role="status" className="document-trash-banner">
            <span>In Trash</span>
            <Button
              variant="outline"
              disabled={transitioning}
              onClick={toggleTrash}
            >
              Restore
            </Button>
          </div>
        )}
        <header>
          {initial ? (
            <>
              <div className="document-eyebrow">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="document-close"
                  aria-label="Close and return"
                  onClick={requestClose}
                >
                  <ArrowLeft aria-hidden="true" />
                </Button>
                <span>Document</span>
                <div className="document-actions">
                  {onTogglePin && (
                    <IconButton
                      label={pinned ? "Unpin Document" : "Pin Document"}
                      aria-pressed={pinned}
                      onClick={onTogglePin}
                    >
                      <Pin fill={pinned ? "currentColor" : "none"} />
                    </IconButton>
                  )}
                  {!trashed && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          label="Document actions"
                          disabled={transitioning}
                        >
                          <MoreHorizontal />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={4}>
                        <DropdownMenuItem onSelect={toggleTrash}>
                          Move to Trash
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
              <h1>{heading}</h1>
            </>
          ) : (
            <>
              <DialogTitle>Capture a thought</DialogTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                className="document-close"
                aria-label="Close and return"
                onClick={requestClose}
              >
                <X aria-hidden="true" />
              </Button>
            </>
          )}
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
            {statusLine}
          </div>
        )}
        {initial && writing && titleField}
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
          <div role="alert" className="document-conflict">
            <p>
              Saved content changed while you were editing. Reload saved content
              to discard your draft, or save my draft to replace the saved
              content with it.
            </p>
            <div className="document-conflict-actions">
              <Button
                variant="outline"
                onClick={() => {
                  saved.current = external;
                  revision.current = externalRevision.current;
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
                  revision.current = externalRevision.current;
                  pending.current = null;
                  externalRef.current = null;
                  setExternal(null);
                  void save();
                }}
              >
                Save my draft
              </Button>
            </div>
          </div>
        )}
        {initial && saveError}
        <div className="document-body">
          {!initial || writing ? (
            <LazyMarkdownEditor
              value={body}
              onChange={(value) => {
                draft.current = { ...draft.current, body: value };
                setBody(value);
              }}
              label="Your thought"
              {...(capture ? { placeholder: "Write a thought…" } : {})}
              readOnly={locked}
              autoFocus={capture}
            />
          ) : (
            <DocumentNavigation.Provider
              value={
                onOpenDocument
                  ? (id) => navigate(() => onOpenDocument(id))
                  : null
              }
            >
              <PlanNavigation.Provider
                value={
                  onOpenPlan ? (id) => navigate(() => onOpenPlan(id)) : null
                }
              >
                <MarkdownDocument
                  source={withoutDerivedHeading(
                    body,
                    title,
                    savedDocument?.heading,
                  )}
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
        {capture && titleField}
        {!initial && saveError}
        <footer>
          {capture && statusLine}
          <Button
            variant={capture ? "default" : "outline"}
            onClick={requestClose}
          >
            {capture ? "Done" : "Back to work"}
          </Button>
        </footer>
      </div>
      {initial && (
        <aside className="document-rail">
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
          {typeof children === "function" ? children({ trashed }) : children}
          {onOpenGraph && (
            <Button
              variant="outline"
              onClick={() => navigate(() => onOpenGraph(initial.id))}
            >
              Context graph
            </Button>
          )}
          {writing && (
            <>
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button disabled={locked} variant="outline">
                    Link a Document
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start">
                  <DocumentPicker
                    exclude={[initial.id]}
                    onPick={(picked) => {
                      const link = documentLinkMarkdown(
                        picked.id,
                        picked.heading,
                      );
                      const next = draft.current.body
                        ? `${draft.current.body}\n\n${link}`
                        : link;
                      draft.current = { ...draft.current, body: next };
                      setBody(next);
                      setLinkError("");
                      setPickerOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </>
          )}
          {linkError && <p role="alert">{linkError}</p>}
          <section aria-label="Connected items">
            <h2>Connected items</h2>
            {links.some((group) => group.length === 100) && (
              <p>Showing the first 100 items in each direction.</p>
            )}
            <ul>
              {connected.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (item.kind === "document")
                        navigate(() => onOpenDocument?.(item.id));
                      else if (item.kind === "ticket")
                        navigate(() => onOpenTicket?.(item.label));
                      else if (item.kind === "plan")
                        navigate(() => onOpenPlan?.(item.id));
                    }}
                  >
                    <ConnectedLabel item={item} />
                    {item.trashed ? " (Trash)" : ""}
                  </Button>
                  <p className="document-direction">
                    {item.to && item.from
                      ? "Links to and linked from"
                      : item.to
                        ? "Links to"
                        : item.kind === "plan" && item.passages.length === 0
                          ? "Uses this Document as its spec"
                          : "Linked from"}
                  </p>
                  {item.passages.map((passage) => (
                    <DocumentNavigation.Provider
                      key={passage}
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
                            source={passage}
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
                  ))}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Create ticket">
            {!creatingFromDocument && (
              <Button
                variant="outline"
                disabled={locked}
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
                disabled={locked || !ticketTitle.trim()}
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
        </aside>
      )}
    </DocumentSurface>
  );
}

type Connection = {
  kind: string;
  id: string;
  label: string;
  trashed: boolean;
  to: boolean;
  from: boolean;
  passages: string[];
};
/** One row per connected item, however many links or directions join it to this Document. */
function groupConnections(links: Awaited<ReturnType<typeof documents.links>>) {
  const rows = new Map<string, Connection>();
  links.forEach((group, direction) => {
    for (const link of group) {
      const out = direction === 0;
      const kind = out ? link.target_kind : link.source_kind;
      const id = out ? link.target_id : link.source_id;
      const key = `${kind}-${id}`;
      const row = rows.get(key) ?? {
        kind,
        id,
        label: out ? link.target_label : link.source_label,
        trashed: out ? link.target_trashed : link.source_trashed,
        to: false,
        from: false,
        passages: [],
      };
      if (out) row.to = true;
      else row.from = true;
      if (link.passage && !row.passages.includes(link.passage))
        row.passages.push(link.passage);
      rows.set(key, row);
    }
  });
  return [...rows.values()];
}
/** Tickets show their title beside the reference; Plans using this Document read "Spec of …". */
function ConnectedLabel({ item }: { item: Connection }) {
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (item.kind !== "ticket") return;
    let current = true;
    void client.showTicket(item.label).then(
      (ticket) => {
        if (current) setTitle(ticket.title);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [item.kind, item.label]);
  if (item.kind === "plan" && item.passages.length === 0)
    return <>Spec of {item.label}</>;
  return <>{title ? `${item.label} · ${title}` : item.label}</>;
}
