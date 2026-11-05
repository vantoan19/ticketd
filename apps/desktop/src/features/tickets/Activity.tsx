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
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
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
type Draft = {
  brief: string;
  /** Null while the update has no details section. */
  details: string | null;
  /** The id of an existing Document attached to the update, or "". */
  support: string;
};
const drafts = new Map<string, Draft>();
const draftKey = (reference: string) => `ticketd:activity-draft:${reference}`;
// Earlier versions kept details and the attachment under their own keys.
const legacyDetailKey = (reference: string) =>
  `ticketd:activity-details:${reference}`;
const legacySupportKey = (reference: string) =>
  `ticketd:activity-support:${reference}`;

function localValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseDraft(raw: string): Draft {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "brief" in value) {
      const { brief, details, support } = value as Record<string, unknown>;
      return {
        brief: typeof brief === "string" ? brief : "",
        details: typeof details === "string" ? details : null,
        support: typeof support === "string" ? support : "",
      };
    }
  } catch {
    /* A plain string is the earlier format: the brief alone. */
  }
  return { brief: raw, details: null, support: "" };
}

function loadDraft(reference: string): Draft {
  const raw = localValue(draftKey(reference));
  const base = raw !== null ? parseDraft(raw) : drafts.get(reference);
  return {
    brief: base?.brief ?? "",
    details: base?.details ?? localValue(legacyDetailKey(reference)),
    support: base?.support || (localValue(legacySupportKey(reference)) ?? ""),
  };
}

const hasDraft = (draft: Draft) =>
  draft.brief !== "" || draft.details !== null || draft.support !== "";

const compactQuery = "(max-width: 1023px)";
/** Below 1024px the composer's secondary actions share one Add menu. */
function useCompactComposer() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(compactQuery);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(compactQuery).matches,
    () => false,
  );
}

/** The first sentence of an update, short enough to quote in a reply. */
function quoteOf(brief: string): string {
  const line =
    brief
      .split("\n")
      .map((text) => text.replace(/^[#>\s*-]+/, "").trim())
      .find(Boolean) ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  const plain = sentence.replace(/\.$/, "");
  return plain.length > 80 ? `${plain.slice(0, 79).trimEnd()}…` : plain;
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
  const [feedback, setFeedback] = useState("");
  const [loadError, setLoadError] = useState("");
  const [targetMissing, setTargetMissing] = useState<string | null>(null);
  const [targetNote, setTargetNote] = useState<AuthoredActivity | null>(null);
  const targetRequest = useRef<{ id: string } | null>(null);
  const targetRef = useRef<HTMLLIElement>(null);
  const revealedTarget = useRef<{ id: string; key: number } | null>(null);
  const targetId = target?.id;
  const targetKey = target?.key;
  // The target a visit already showed is not looked up again when the ticket is
  // selected afresh; only a newly opened target (a new key) is.
  const leftTargetKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    return () => {
      leftTargetKey.current = targetKey;
    };
  }, [active, targetKey]);
  useEffect(() => {
    if (!active || targetId === undefined) return;
    if (targetKey !== undefined && leftTargetKey.current === targetKey) return;
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
  // Leaving the ticket ends the "no longer available" notice for good, and
  // the confirmation of a deletion belongs to the ticket it happened on.
  const [wasActive, setWasActive] = useState(active);
  const [wasReference, setWasReference] = useState(reference);
  if (wasActive !== active || wasReference !== reference) {
    setWasActive(active);
    setWasReference(reference);
    if (!active || wasReference !== reference) {
      setTargetMissing(null);
      setFeedback("");
    }
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
  const [saved, setSaved] = useState<Draft>(() => loadDraft(ticketId));
  const savedRef = useRef(saved);
  const [composing, setComposing] = useState(() => hasDraft(saved));
  const requestKey = `ticketd:activity-request:${ticketId}`;
  /** Changes part of the draft and keeps the whole draft, as one object, on this device. */
  function updateDraft(patch: Partial<Draft>) {
    const next = { ...savedRef.current, ...patch };
    savedRef.current = next;
    setSaved(next);
    try {
      if (hasDraft(next)) {
        drafts.set(ticketId, next);
        localStorage.setItem(draftKey(ticketId), JSON.stringify(next));
      } else {
        drafts.delete(ticketId);
        localStorage.removeItem(draftKey(ticketId));
      }
      localStorage.removeItem(legacyDetailKey(ticketId));
      localStorage.removeItem(legacySupportKey(ticketId));
      if (patch.support !== undefined) localStorage.removeItem(requestKey);
    } catch {
      setError("Could not save the unpublished update on this device.");
    }
  }
  // Write the draft once more as the page goes away, so a quick quit keeps it.
  useEffect(() => {
    const flush = () => {
      try {
        if (hasDraft(savedRef.current))
          localStorage.setItem(
            draftKey(ticketId),
            JSON.stringify(savedRef.current),
          );
      } catch {
        /* The draft stays in memory. */
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [ticketId]);
  function clearDraft() {
    updateDraft({ brief: "", details: null, support: "" });
    try {
      localStorage.removeItem(requestKey);
    } catch {
      setError("Could not clear the unpublished update on this device.");
    }
  }
  const draft = saved.brief;
  const details = saved.details ?? "";
  const showDetails = saved.details !== null;
  const support = saved.support;
  const setDraft = (brief: string) => updateDraft({ brief });
  const setDetails = (value: string) => updateDraft({ details: value });
  const setSupport = (value: string) => updateDraft({ support: value });
  const [supportTitle, setSupportTitle] = useState("");
  /** What each update's details Document is called and whether it is in Trash. */
  const [detailDocuments, setDetailDocuments] = useState<
    Record<string, { heading: string; trashed: boolean; attached: boolean }>
  >({});
  const [picking, setPicking] = useState(false);
  const compact = useCompactComposer();
  // Bumped to put the caret in the update editor / the new Details editor.
  const [focusUpdate, setFocusUpdate] = useState(0);
  const [focusDetails, setFocusDetails] = useState(false);
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
  const [edit, setEdit] = useState<{
    id: string;
    original: string;
    content: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
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
  function startDetails() {
    setDetails("");
    setPicking(false);
    setFocusDetails(true);
  }
  /** Replies start from a quote of the update, in the same composer. */
  function reply(brief: string) {
    const base = hasVisibleText(draft) ? `${draft.trimEnd()}\n\n` : "";
    setComposing(true);
    setDraft(`${base}> Re: ${quoteOf(brief)}\n\n`);
    setFocusUpdate((count) => count + 1);
  }
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
        clearDraft();
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
  const detailIds = displayedNotes.flatMap((note) =>
    note.supporting_document_id ? [note.supporting_document_id] : [],
  );
  const detailIdsKey = detailIds.join(",");
  useEffect(() => {
    if (!active || !detailIdsKey) return;
    let current = true;
    for (const id of detailIdsKey.split(","))
      void documents
        .show(id)
        .then((document) => {
          if (current)
            setDetailDocuments((previous) => ({
              ...previous,
              [id]: {
                heading: document.title || document.heading || "Document",
                trashed: document.trashed,
                // Generated details remember the update they came from.
                attached: !document.origin_brief,
              },
            }));
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [active, detailIdsKey, revision]);
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
                placeholder="Write an update…"
                value={draftText}
                onChange={(content) =>
                  edit ? setEdit({ ...edit, content }) : setDraft(content)
                }
                readOnly={pending}
                focusRequest={focusUpdate}
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
                placeholder="Technical notes, logs or Markdown. Kept as a Document with this update."
                value={details}
                onChange={setDetails}
                readOnly={pending}
                autoFocus={focusDetails}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setFocusDetails(false);
                  updateDraft({ details: null });
                  try {
                    localStorage.removeItem(requestKey);
                  } catch {
                    /* The retry id is best effort. */
                  }
                }}
              >
                Remove details
              </Button>
            </Field>
          )}
          {!edit && support && (
            <p className="activity-attached">
              <FileText aria-hidden="true" />
              <span className="truncate">
                Attached: {supportTitle || "Document"}
              </span>
              <span aria-hidden="true">·</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove attached Document"
                onClick={() => setSupport("")}
              >
                Remove
              </Button>
              <span className="activity-muted">
                Remove it to write details instead.
              </span>
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
          <div
            className="activity-actions"
            data-sticky={(!edit && showDetails) || undefined}
          >
            {!edit && !showDetails && compact && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Add details or a Document"
                  >
                    <Plus aria-hidden="true" />
                    Add
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    disabled={!!support}
                    onSelect={startDetails}
                  >
                    Add details
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!!support}
                    onSelect={() => setPicking(true)}
                  >
                    Attach Document
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!edit && !showDetails && !compact && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!!support}
                title={
                  support
                    ? "Remove the attached Document to write details instead"
                    : undefined
                }
                onClick={startDetails}
              >
                <Plus aria-hidden="true" />
                Add details
              </Button>
            )}
            {!edit && !showDetails && !support && !compact && (
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
              ) : hasDraft(saved) ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={pending}
                      aria-label="Draft actions"
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        clearDraft();
                        setPicking(false);
                        setComposing(false);
                      }}
                    >
                      Discard draft
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setPicking(false);
                    setComposing(false);
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={pending || !hasVisibleText(draftText)}
                aria-describedby={
                  !pending && !hasVisibleText(draftText)
                    ? `post-hint-${ticketId}`
                    : undefined
                }
              >
                {pending ? "Saving…" : edit ? "Save update" : "Post update"}
              </Button>
            </span>
          </div>
          {!pending && !hasVisibleText(draftText) && (
            <p id={`post-hint-${ticketId}`} className="activity-caption">
              {edit ? "An update needs some text." : "Write an update to post."}
            </p>
          )}
          {!edit && hasDraft(saved) && (
            <p className="activity-caption">Draft kept on this device</p>
          )}
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
                          disabled={!!edit}
                          onSelect={() => reply(item.note.brief)}
                        >
                          Reply
                        </DropdownMenuItem>
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
                          onSelect={() => setConfirmDelete(item.note.id)}
                        >
                          Delete update
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                {confirmDelete === item.note.id && (
                  <p role="alertdialog" className="activity-confirm">
                    {item.note.supporting_document_id
                      ? "Delete update? Its details stay in Documents."
                      : "Delete update?"}
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
                <ClampedBrief>
                  <MarkdownDocument
                    source={item.note.brief}
                    select={select}
                    revision={revision}
                  />
                </ClampedBrief>
                {item.note.supporting_document_id && (
                  <DetailsLink
                    info={detailDocuments[item.note.supporting_document_id]}
                    open={() =>
                      openDocument?.(item.note.supporting_document_id!)
                    }
                  />
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

/** The link from an update to its details Document, named by what it holds. */
/** A long update stays a few lines tall until Show more is chosen. */
function ClampedBrief({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      if (!expanded)
        setClipped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <>
      <div
        ref={box}
        className="markdown-preview activity-note"
        data-expanded={expanded || undefined}
      >
        {children}
      </div>
      {(clipped || expanded) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </>
  );
}

function DetailsLink({
  info,
  open,
}: {
  info: { heading: string; trashed: boolean; attached: boolean } | undefined;
  open: () => void;
}) {
  if (!info)
    return (
      <Button type="button" variant="link" onClick={open}>
        Open details
      </Button>
    );
  return (
    <Button
      type="button"
      variant="link"
      className="activity-details-link"
      onClick={open}
    >
      <span className="truncate">
        {info.attached ? "Attached" : "Details"} · {info.heading}
      </span>
      {info.trashed && <span className="activity-muted">In Trash</span>}
    </Button>
  );
}
