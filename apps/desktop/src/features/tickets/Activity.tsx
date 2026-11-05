import { documents } from "@/features/documents/api";
import { DocumentPicker } from "./DocumentPicker";
import { hasVisibleText } from "./brief-text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DocumentNavigation } from "@/features/documents/navigation";
import { useNow } from "@/lib/use-now";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileText, MoreHorizontal, Plus, History } from "lucide-react";
import {
  client,
  type AuthoredActivity,
  type ActivityFeedEntry,
  type Project,
} from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { historySentence } from "./history-sentence";
import { attribution } from "./ticket-source";
import { relativeDateTime, formatDateTime } from "@/lib/format";
import { revealInDetail } from "./detail-scroll";
import "./activity.css";

/**
 * Unsubmitted update drafts by ticket identity. They outlive this component so
 * switching tickets, or the detail remounting, never loses typed text.
 */
const noteDrafts = new Map<string, string>();
const draftKey = (reference: string) => `ticketd:activity-draft:${reference}`;

function localValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadDraft(reference: string): string {
  try {
    return (
      localStorage.getItem(draftKey(reference)) ??
      noteDrafts.get(reference) ??
      ""
    );
  } catch {
    return noteDrafts.get(reference) ?? "";
  }
}

export function Activity({
  reference,
  ticketId = reference,
  status,
  revision,
  projects,
  active,
  trashed,
  select,
  target,
  plans = [],
  sourceName,
  latestNoteId,
  onChanged,
}: {
  sourceName?: string | undefined;
  latestNoteId?: string | undefined;
  onChanged?: () => Promise<void>;
  reference: string;
  ticketId?: string;
  status: string;
  revision: number;
  projects: Project[];
  active: boolean;
  trashed: boolean;
  select?: (reference: string) => void;
  target?: { id: string; key: number } | null;
  plans?: Plan[];
}) {
  const now = useNow();
  const [loadError, setLoadError] = useState("");
  const [targetMissing, setTargetMissing] = useState<string | null>(null);
  const [targetNote, setTargetNote] = useState<AuthoredActivity | null>(null);
  const targetRequest = useRef<{ id: string } | null>(null);
  const targetRef = useRef<HTMLLIElement>(null);
  const revealedTarget = useRef<{ id: string; key: number } | null>(null);
  const targetId = target?.id;
  const targetKey = target?.key;
  useEffect(() => {
    if (!active || targetId === undefined) return;
    let current = true;
    const request = { id: targetId };
    targetRequest.current = request;
    void client
      .activity(reference, targetId)
      .then((note) => {
        if (current && targetRequest.current === request) {
          setTargetNote(note);
          setTargetMissing(note === null ? targetId : null);
        }
      })
      .catch((reason: unknown) => {
        if (current && targetRequest.current === request)
          setLoadError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [active, reference, revision, targetId, targetKey]);
  // Leaving the ticket ends the "no longer available" notice for good.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setTargetMissing(null);
  }
  const [feed, setFeed] = useState<ActivityFeedEntry[]>([]);
  const notes = feed.flatMap((item) =>
    item.type === "authored" ? [item.activity] : [],
  );
  const history = feed.flatMap((item) =>
    item.type === "automatic" ? [item.event] : [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraftValue] = useState(() => loadDraft(ticketId));
  const [composing, setComposing] = useState(() =>
    Boolean(
      loadDraft(ticketId) ||
      localValue(`ticketd:activity-details:${ticketId}`) !== null ||
      localValue(`ticketd:activity-support:${ticketId}`),
    ),
  );
  function setDraft(content: string) {
    if (content) noteDrafts.set(ticketId, content);
    else noteDrafts.delete(ticketId);
    try {
      if (content) localStorage.setItem(draftKey(ticketId), content);
      else localStorage.removeItem(draftKey(ticketId));
    } catch {
      setError("Could not save the unpublished update on this device.");
    }
    setDraftValue(content);
  }
  const detailKey = `ticketd:activity-details:${ticketId}`;
  const selectionKey = `ticketd:activity-support:${ticketId}`;
  const requestKey = `ticketd:activity-request:${ticketId}`;
  const [details, setDetailsValue] = useState(
    () => localValue(detailKey) ?? "",
  );
  const [showDetails, setShowDetails] = useState(
    () => localValue(detailKey) !== null,
  );
  const [support, setSupportValue] = useState(
    () => localValue(selectionKey) ?? "",
  );
  const [supportTitle, setSupportTitle] = useState("");
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<"all" | "updates">("all");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const openDocument = useContext(DocumentNavigation);
  useEffect(() => {
    if (!active || !support) return;
    let current = true;
    void documents
      .show(support)
      .then((document) => {
        if (current)
          setSupportTitle(document.title || document.heading || "Document");
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [active, support]);
  function setDetails(value: string) {
    setDetailsValue(value);
    try {
      localStorage.setItem(detailKey, value);
    } catch {
      setError("Could not save the unpublished update on this device.");
    }
  }
  function setSupport(value: string) {
    setSupportValue(value);
    try {
      if (value) localStorage.setItem(selectionKey, value);
      else localStorage.removeItem(selectionKey);
      localStorage.removeItem(requestKey);
    } catch {
      setError("Could not save the unpublished update on this device.");
    }
  }
  const [edit, setEdit] = useState<{
    id: string;
    original: string;
    content: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const busy = useRef(false);
  const pages = useRef(1);
  const [more, setMore] = useState(false);
  const loadNotes = useCallback(async () => {
    const loaded: ActivityFeedEntry[] = [];
    let page: ActivityFeedEntry[] = [];
    for (let index = 0; index < pages.current; index++) {
      page = await client.activityFeed(reference, index * 50);
      loaded.push(...page);
      if (page.length < 50) break;
    }
    setFeed(loaded);
    setMore(page.length === 50);
  }, [reference]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void Promise.resolve()
      .then(() => loadNotes())
      .then(() => {
        if (current) {
          setLoadError("");
        }
      })
      .catch((reason: unknown) => {
        if (current) setLoadError(String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, loadNotes, reference, revision, status]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      event.target !== event.currentTarget ||
      busy.current ||
      trashed ||
      !hasVisibleText(edit ? edit.content : draft)
    )
      return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      if (edit) {
        const savedNote = await client.editActivity(
          reference,
          edit.id,
          edit.content,
        );
        if (targetRequest.current?.id === savedNote.id)
          targetRequest.current = null;
        setTargetNote((previous) =>
          previous?.id === savedNote.id ? savedNote : previous,
        );
      } else {
        const payload = JSON.stringify([
          reference,
          draft,
          showDetails ? details : null,
          support || null,
        ]);
        const previous = localValue(requestKey);
        let requestId: string = crypto.randomUUID();
        if (previous) {
          try {
            const saved: unknown = JSON.parse(previous);
            if (
              typeof saved === "object" &&
              saved !== null &&
              "payload" in saved &&
              "id" in saved &&
              saved.payload === payload &&
              typeof saved.id === "string"
            )
              requestId = saved.id;
          } catch {
            /* Replace malformed local state. */
          }
        }
        try {
          localStorage.setItem(
            requestKey,
            JSON.stringify({ payload, id: requestId }),
          );
        } catch {
          /* The retry id is best effort; a full store must not block posting. */
        }
        await client.addActivityWithDetails(
          reference,
          draft,
          showDetails ? details : null,
          support || null,
          requestId,
        );
      }
      if (edit) setEdit(null);
      else {
        setDraft("");
        try {
          localStorage.removeItem(detailKey);
          localStorage.removeItem(selectionKey);
          localStorage.removeItem(requestKey);
        } catch {
          setError("Could not clear the unpublished update on this device.");
        }
        setDetailsValue("");
        setSupportValue("");
        setShowDetails(false);
        setComposing(false);
      }
      await loadNotes();
      await onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function remove(id: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const hadSupport = notes.some(
        (note) => note.id === id && note.supporting_document_id,
      );
      await client.deleteActivity(reference, id);
      setConfirmDelete(null);
      setFeedback(
        hadSupport
          ? "Update deleted. Its details stay in Documents."
          : "Update deleted.",
      );
      if (targetRequest.current?.id === id) targetRequest.current = null;
      setTargetNote((previous) => (previous?.id === id ? null : previous));
      await loadNotes();
      await onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function loadMore() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const page = await client.activityFeed(reference, feed.length);
      pages.current += 1;
      setFeed((previous) => [...previous, ...page]);
      setMore(page.length === 50);
    } catch (reason) {
      setError(String(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  // A note reached from elsewhere may be older than the loaded page. Add it to
  // the same chronological list, and replace it with the paged copy when loaded.
  const displayedNotes =
    active &&
    targetNote !== null &&
    targetId !== undefined &&
    targetNote.id === targetId &&
    !notes.some((note) => note.id === targetId)
      ? [...notes, targetNote]
      : notes;
  const changed =
    edit &&
    !displayedNotes.some(
      (note) => note.id === edit.id && note.brief === edit.original,
    );
  useLayoutEffect(() => {
    if (!active || targetId === undefined || targetKey === undefined) {
      revealedTarget.current = null;
      return;
    }
    if (
      revealedTarget.current?.id === targetId &&
      revealedTarget.current.key === targetKey
    )
      return;
    const element = targetRef.current;
    if (!element) return;
    revealInDetail(element);
    element.focus({ preventScroll: true });
    revealedTarget.current = { id: targetId, key: targetKey };
  }, [active, targetId, targetKey, feed, targetNote]);
  const entries = [
    ...displayedNotes.map((note) => ({
      type: "note" as const,
      timestamp: note.reported_at,
      note,
    })),
    ...history.map((entry, index) => ({
      type: "history" as const,
      timestamp: entry.timestamp,
      entry,
      index,
    })),
  ]
    .filter((item) => view === "all" || item.type === "note")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  // The newest update still in the list, so deleting the latest one moves the label.
  const newestNoteId = displayedNotes.reduce<AuthoredActivity | null>(
    (best, note) =>
      best === null || note.reported_at > best.reported_at ? note : best,
    null,
  )?.id;
  const lookups = {
    project: (id: string) =>
      projects.find((project) => project.id === id)?.name,
    plan: (id: string) => plans.find((plan) => plan.id === id)?.name,
  };
  const draftText = edit ? edit.content : draft;
  return (
    <section className="activity" aria-label="Activity">
      <div className="activity-heading">
        <h3>Activity</h3>
        <SegmentedControl
          aria-label="Show activity"
          value={view}
          onValueChange={setView}
          options={[
            { value: "all", label: "All" },
            { value: "updates", label: "Updates" },
          ]}
        />
        <span>
          Only in ticketd{sourceName && <> · never sent to {sourceName}</>}
        </span>
      </div>
      {feedback && (
        <p role="status" className="activity-muted">
          {feedback}
        </p>
      )}
      {targetMissing === targetId && targetId !== undefined && (
        <Alert>
          <AlertDescription>
            This update is no longer available. Refresh updates to see the
            current activity.
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                setTargetMissing(null);
                void onChanged?.();
              }}
            >
              Refresh updates
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {(error || loadError) && (
        <Alert variant="destructive">
          <AlertDescription>{error || loadError}</AlertDescription>
        </Alert>
      )}
      {!trashed && !composing && !edit && (
        <button
          type="button"
          className="activity-compact-composer"
          onClick={() => setComposing(true)}
        >
          Write an update…
        </button>
      )}
      {!trashed && (composing || edit) && (
        <form
          className="activity-composer"
          onSubmit={(event) => void save(event)}
        >
          <FieldGroup>
            <Field data-disabled={pending}>
              <FieldLabel className="sr-only" asChild>
                <span>{edit ? "Edit update" : "New update"}</span>
              </FieldLabel>
              <LazyMarkdownEditor
                key={edit?.id ?? "new"}
                label={edit ? "Edit update" : "New update"}
                value={draftText}
                onChange={(content) =>
                  edit ? setEdit({ ...edit, content }) : setDraft(content)
                }
                readOnly={pending}
              />
            </Field>
          </FieldGroup>
          {!edit && showDetails && (
            <Field>
              <FieldLabel asChild>
                <span>Details</span>
              </FieldLabel>
              <LazyMarkdownEditor
                label="Details"
                value={details}
                onChange={setDetails}
                readOnly={pending}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  try {
                    localStorage.removeItem(detailKey);
                    localStorage.removeItem(requestKey);
                  } catch {
                    setError(
                      "Could not clear the unpublished details on this device.",
                    );
                  }
                  setDetailsValue("");
                  setShowDetails(false);
                }}
              >
                Remove details
              </Button>
            </Field>
          )}
          {!edit && support && (
            <p className="activity-attached">
              <FileText aria-hidden="true" />
              <span className="truncate">{supportTitle || "Document"}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSupport("")}
              >
                Remove Document
              </Button>
            </p>
          )}
          {!edit && picking && (
            <DocumentPicker
              onPick={(picked) => {
                setSupport(picked.id);
                setSupportTitle(picked.heading);
                setPicking(false);
              }}
            />
          )}
          {changed && (
            <p role="status" className="activity-muted">
              The saved update changed while you were editing. Your draft is
              preserved; saving will replace the saved content.
            </p>
          )}
          <div className="activity-actions">
            {!edit && !showDetails && !support && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDetails(true);
                  setDetails("");
                  setPicking(false);
                }}
              >
                <Plus aria-hidden="true" />
                Add details
              </Button>
            )}
            {!edit && !showDetails && !support && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={picking}
                onClick={() => setPicking(!picking)}
              >
                <FileText aria-hidden="true" />
                Attach Document
              </Button>
            )}
            <span className="activity-actions-end">
              {!edit && (
                <span className="activity-muted">
                  Draft kept on this device
                </span>
              )}
              {edit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setEdit(null)}
                >
                  Cancel edit
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setDraft("");
                    try {
                      localStorage.removeItem(detailKey);
                      localStorage.removeItem(selectionKey);
                      localStorage.removeItem(requestKey);
                    } catch {
                      setError(
                        "Could not clear the unpublished update on this device.",
                      );
                    }
                    setDetailsValue("");
                    setSupportValue("");
                    setShowDetails(false);
                    setPicking(false);
                    setComposing(false);
                  }}
                >
                  Discard draft
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={pending || !hasVisibleText(draftText)}
              >
                {pending ? "Saving…" : edit ? "Save update" : "Post update"}
              </Button>
            </span>
          </div>
        </form>
      )}
      {loading && entries.length === 0 ? (
        <p className="activity-muted" role="status">
          Loading activity…
        </p>
      ) : entries.length === 0 && !error && !loadError ? (
        <Empty className="activity-empty">
          <EmptyHeader>
            <EmptyDescription>
              No updates or recorded changes yet.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="activity-list">
          {entries.map((item) =>
            item.type === "note" ? (
              <li
                key={`note-${item.note.id}`}
                className="activity-entry"
                ref={
                  active &&
                  item.note.id === targetId &&
                  targetNote?.id === targetId
                    ? targetRef
                    : undefined
                }
                tabIndex={
                  active &&
                  item.note.id === targetId &&
                  targetNote?.id === targetId
                    ? -1
                    : undefined
                }
                aria-label={
                  active &&
                  item.note.id === targetId &&
                  targetNote?.id === targetId
                    ? "Selected update"
                    : undefined
                }
              >
                <div className="activity-meta">
                  <strong>
                    {item.note.id === (newestNoteId ?? latestNoteId)
                      ? "Latest update"
                      : "Update"}
                  </strong>
                  <time
                    dateTime={item.note.reported_at}
                    title={formatDateTime(item.note.reported_at)}
                  >
                    {relativeDateTime(item.note.reported_at, now)}
                  </time>
                  {item.note.updated_at !== item.note.reported_at && (
                    <span>Edited {formatDateTime(item.note.updated_at)}</span>
                  )}
                  {item.note.editing_agent && (
                    <span>Agent: {item.note.editing_agent}</span>
                  )}
                  {!trashed && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="activity-menu"
                          disabled={pending}
                          aria-label={`Actions for update from ${formatDateTime(item.note.reported_at)}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() =>
                            setEdit({
                              id: item.note.id,
                              original: item.note.brief,
                              content: item.note.brief,
                            })
                          }
                        >
                          Edit update
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            item.note.supporting_document_id
                              ? setConfirmDelete(item.note.id)
                              : void remove(item.note.id)
                          }
                        >
                          Delete update
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                {confirmDelete === item.note.id && (
                  <p role="alertdialog" className="activity-confirm">
                    Delete update? Its details stay in Documents.
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => void remove(item.note.id)}
                    >
                      Delete update
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Keep update
                    </Button>
                  </p>
                )}
                <div className="markdown-preview activity-note">
                  <MarkdownDocument
                    source={item.note.brief}
                    select={select}
                    revision={revision}
                  />
                </div>
                {item.note.supporting_document_id && (
                  <Button
                    type="button"
                    variant="link"
                    onClick={() =>
                      openDocument?.(item.note.supporting_document_id!)
                    }
                  >
                    Open details
                  </Button>
                )}
              </li>
            ) : (
              <li key={`history-${item.index}`} className="activity-history">
                <History aria-hidden="true" className="activity-history-icon" />
                <span>{historySentence(item.entry, lookups)}</span>
                <time
                  dateTime={item.entry.timestamp}
                  title={formatDateTime(item.entry.timestamp)}
                >
                  {relativeDateTime(item.entry.timestamp, now)}
                </time>
                {item.entry.editing_agent && (
                  <span>{attribution(item.entry.editing_agent)}</span>
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {more && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void loadMore()}
        >
          Load more activity
        </Button>
      )}
    </section>
  );
}
