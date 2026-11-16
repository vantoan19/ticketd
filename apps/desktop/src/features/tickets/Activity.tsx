import { preserveNewerFocus } from "@/components/ui/use-focus-return";
import { FloatingEditBar } from "@/features/markdown/FloatingEditBar";
import { onTicketUpdate } from "./activity-composer-request";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { editingHarness } from "@/features/chats/editing-harness";
import { Pager } from "@/components/ui/pager";
import { SectionHeader } from "@/components/ui/section-header";
import { Tooltip } from "@/components/ui/tooltip";
import { documents } from "@/features/documents/api";
import { DocumentPicker } from "./DocumentPicker";
import { hasVisibleText } from "./brief-text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DocumentNavigation } from "@/features/documents/navigation";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { chatSource } from "@/features/chats/quotes";
import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Card } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Clamp } from "@/components/ui/disclosure";
import { Time } from "@/components/ui/time";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert } from "@/components/ui/failure-alert";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bot,
  FileText,
  History,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  CommentRow,
  EventRow,
  EventGroup,
  Timeline,
} from "@/components/ui/timeline";
import {
  client,
  type AuthoredActivity,
  type ActivityFeedEntry,
  type Project,
} from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { historySentence } from "./history-sentence";
import type { Entry } from "@/lib/api/history";
import { historyIcon } from "./history-icon";
import { attribution } from "./ticket-source";
import { formatDateTime } from "@/lib/format";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { revealInDetail } from "./detail-scroll";
import { z } from "zod";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { useOpenTicket } from "./open-ticket";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
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
const recoveryDraftSchema = z.object({
  brief: z.string(),
  details: z.string().nullable(),
  support: z.string(),
});
const editDraftSchema = z.object({
  id: z.string(),
  original: z.string(),
  content: z.string(),
});
const requestSchema = z.object({ payload: z.string(), id: z.string() });
const drafts = new Map<string, Draft>();
const noFeed: ActivityFeedEntry[] = [];
const draftKey = (reference: string) => `ticketd:activity-draft:${reference}`;

/** A failure on this device's draft storage: plain words, nothing for Details. */
function draftFailure(title: string, text: string): FailureDescription {
  return { code: "failed", title, sentence: text, action: null, details: "" };
}
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

/** The first sentence of an update, short enough to quote in a reply. */
function quoteOf(brief: string): string {
  const line =
    brief
      .split("\n")
      .map((text) => text.replace(/^[#>\s*-]+/, "").trim())
      .find(Boolean) ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  const plain = sentence.replace(/\.$/, "");
  if (plain.length <= 80) return plain;
  // Cut at a word boundary so the quote never ends mid-word.
  const cut = plain.slice(0, 79);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function Activity({
  reference,
  ticketId = reference,
  projects,
  active,
  trashed,
  select,
  target,
  plans = [],
  sourceName,
  latestNoteId,
  foldEmpty = false,
}: {
  foldEmpty?: boolean;
  sourceName?: string | undefined;
  latestNoteId?: string | undefined;
  reference: string;
  ticketId?: string;
  projects: Project[];
  active: boolean;
  trashed: boolean;
  select?: (reference: string) => void;
  target?: { id: string; key: number } | null;
  plans?: Plan[];
}) {
  const recovery = useDraftRecovery();
  const targetId = target?.id;
  const targetKey = target?.key;
  const recoveryOwner = `activity:${ticketId}`;
  const statusLine = useStatusLine();
  const submitHint = shortcutLabel("update-post");
  const [deleteError, setDeleteError] = useState<FailureDescription | null>(
    null,
  );
  const targetRef = useRef<HTMLLIElement>(null);
  const revealedTarget = useRef<{ id: string; key: number } | null>(null);
  const { changed } = useOpenTicket();
  // Unmigrated readers below (Documents, Markdown) still follow the change signal.
  const revision = useWorkspaceChange();
  const activity = useOpenTicket("activity");
  const note = useOpenTicket("activityNote", targetId);
  const targetNote: AuthoredActivity | null = note.value ?? null;
  // A target whose notice was dismissed by leaving the ticket stays dismissed
  // until a new target (a new key) is opened.
  const [leftTargetKey, setLeftTargetKey] = useState<number | undefined>();
  const [wasActive, setWasActive] = useState(active);
  const [wasReference, setWasReference] = useState(reference);
  if (wasActive !== active || wasReference !== reference) {
    setWasActive(active);
    setWasReference(reference);
    if (!active || wasReference !== reference) setLeftTargetKey(targetKey);
  }
  const targetMissing =
    targetId !== undefined &&
    note.value === null &&
    (targetKey === undefined || leftTargetKey !== targetKey)
      ? targetId
      : null;
  const feed = activity.value ?? noFeed;
  const notes = feed.flatMap((item) =>
    item.type === "authored" ? [item.activity] : [],
  );
  const history = feed.flatMap((item) =>
    item.type === "automatic" ? [item] : [],
  );
  const loading = activity.value === undefined && activity.failure === null;
  const [error, setError] = useState<FailureDescription | null>(null);
  const loadError = activity.failure ?? note.failure;
  const [saved, setSaved] = useState<Draft>(
    () =>
      recovery.read(recoveryOwner, recoveryDraftSchema) ??
      (recovery.active
        ? { brief: "", details: null, support: "" }
        : loadDraft(ticketId)),
  );
  const savedRef = useRef(saved);
  const [composing, setComposing] = useState(() => hasDraft(saved));
  const requestKey = `ticketd:activity-request:${ticketId}`;
  /** Changes part of the draft and keeps the whole draft, as one object, on this device. */
  function updateDraft(patch: Partial<Draft>) {
    const next = { ...savedRef.current, ...patch };
    savedRef.current = next;
    setSaved(next);
    if (recovery.active) {
      void recovery
        .put(
          recoveryOwner,
          hasDraft(next) ? next : null,
          [next.brief, next.details ?? ""].filter(Boolean),
        )
        .catch(() => {});
      return;
    }
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
      setError(
        draftFailure(
          "Couldn't save the unpublished update on this device",
          "Copy it before you close ticketd.",
        ),
      );
    }
  }
  // Write the draft once more as the page goes away, so a quick quit keeps it.
  useEffect(() => {
    const flush = () => {
      if (recovery.active) return;
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
  }, [ticketId, recovery]);
  function clearDraft() {
    updateDraft({ brief: "", details: null, support: "" });
    if (recovery.active) {
      void recovery.put(requestKey, null, []).catch(() => {});
      return;
    }
    try {
      localStorage.removeItem(requestKey);
    } catch {
      setError(
        draftFailure(
          "Couldn't clear the unpublished update on this device",
          "It may come back the next time this ticket opens.",
        ),
      );
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
  const [controlsOwner, setControlsOwner] = useState<"brief" | "details">(
    "brief",
  );
  const composerRef = useRef<HTMLFormElement>(null);
  // Where the editors put their controls: the composer's and the edit's bottom row.
  const [controlsHost, setControlsHost] = useState<HTMLSpanElement | null>(
    null,
  );
  const [editControlsHost, setEditControlsHost] =
    useState<HTMLSpanElement | null>(null);
  // Bumped to put the caret in the update editor / the new Details editor.
  const [focusUpdate, setFocusUpdate] = useState(0);
  const [focusDetails, setFocusDetails] = useState(false);
  const replied = useRef(false);
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
        if (current)
          setError(describeFailure(reason, "load the attached Document"));
      });
    return () => {
      current = false;
    };
  }, [active, support]);
  const [edit, setEdit] = useState<{
    id: string;
    original: string;
    content: string;
  } | null>(() => recovery.read(`activity-edit:${ticketId}`, editDraftSchema));
  useEffect(() => {
    void recovery
      .put(`activity-edit:${ticketId}`, edit, edit ? [edit.content] : [])
      .catch(() => {});
  }, [edit, recovery, ticketId]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
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
    replied.current = true;
    // The composer may be far above the row replied to.
    window.requestAnimationFrame(() => {
      if (composerRef.current) revealInDetail(composerRef.current);
    });
  }
  useEffect(() => {
    if (!active || trashed) return;
    return onTicketUpdate(reference, (quote) => {
      if (quote) reply(quote);
      else setComposing(true);
      setFocusUpdate((count) => count + 1);
    });
  });
  const post = (event: FormEvent<HTMLFormElement>) => save(event, null);
  const saveEdit = (event: FormEvent<HTMLFormElement>) => save(event, edit);
  async function save(
    event: FormEvent<HTMLFormElement>,
    edit: { id: string; original: string; content: string } | null,
  ) {
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
    setError(null);
    try {
      await recovery.flush();
      if (edit) {
        await client.editActivity(reference, edit.id, edit.content);
      } else {
        const payload = JSON.stringify([
          reference,
          draft,
          showDetails ? details : null,
          support || null,
        ]);
        const previous = recovery.active
          ? JSON.stringify(recovery.read(requestKey, requestSchema))
          : localValue(requestKey);
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
        if (recovery.active)
          await recovery.put(requestKey, { payload, id: requestId }, []);
        else
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
      if (edit) {
        await recovery.put(`activity-edit:${ticketId}`, null, []);
        setEdit(null);
      } else {
        clearDraft();
        if (recovery.active) await recovery.put(requestKey, null, []);
        setComposing(false);
      }
      await changed();
    } catch (reason) {
      setError(
        describeFailure(reason, edit ? "save the update" : "post the update"),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function remove(id: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setDeleteError(null);
    try {
      const hadSupport = notes.some(
        (note) => note.id === id && note.supporting_document_id,
      );
      await client.deleteActivity(reference, id);
      setConfirmDelete(null);
      // An outcome, said in the pane's status line, never inserted (DB-09).
      statusLine.show({
        message: hadSupport
          ? "Deleted the update. Its details stay in Documents."
          : "Deleted the update",
      });
      await changed();
    } catch (reason) {
      setDeleteError(describeFailure(reason, "delete the update"));
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
    // The arrival flash shows which update was asked for (P2).
    element.classList.add("ui-arrived");
    window.setTimeout(() => element.classList.remove("ui-arrived"), 1600);
    revealedTarget.current = { id: targetId, key: targetKey };
  }, [active, targetId, targetKey, feed, targetNote]);
  const chronological = [
    ...displayedNotes.map((note) => ({
      type: "note" as const,
      timestamp: note.reported_at,
      note,
    })),
    ...history.map((item) => ({
      type: "history" as const,
      timestamp: item.event.timestamp,
      id: item.id,
      entry: item.event,
    })),
  ]
    .filter((item) => view === "all" || item.type === "note")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  // Fold only adjacent recorded changes in the merged chronology. Authored
  // updates are boundaries, even when changes share a kind or timestamp.
  type Group = {
    type: "history";
    id: number;
    timestamp: string;
    changes: Entry[];
  };
  const entries = chronological.reduce<
    (Extract<(typeof chronological)[number], { type: "note" }> | Group)[]
  >((rows, item) => {
    if (item.type === "note") rows.push(item);
    else {
      const previous = rows.at(-1);
      if (previous?.type === "history") previous.changes.push(item.entry);
      else
        rows.push({
          type: "history",
          id: item.id,
          timestamp: item.timestamp,
          changes: [item.entry],
        });
    }
    return rows;
  }, []);
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
  const hasText = hasVisibleText(draft);
  const postHintId = `post-hint-${ticketId}`;
  // ⌘↵ / Ctrl+Enter posts from anywhere in the frame (DB-10).
  const submitKey = (event: KeyboardEvent<HTMLFormElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.requestSubmit();
    }
  };
  // What "+" offers: details, or one of the person's Documents as details.
  const offerDetails = !showDetails && !support;
  const plus = offerDetails && (
    <Popover open={picking} onOpenChange={setPicking}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <IconButton
              type="button"
              label="Add details or a Document"
              disabled={pending}
            >
              <Plus aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={startDetails}>
            <FileText aria-hidden="true" />
            Add details
          </DropdownMenuItem>
          <DropdownMenuItem
            // The picker opens once the menu has closed, under the same "+".
            onSelect={() => window.setTimeout(() => setPicking(true), 0)}
          >
            <Link2 aria-hidden="true" />
            Use a Document as details…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent variant="list" align="end" aria-label="Choose a Document">
        <DocumentPicker
          onPick={(picked) => {
            setSupport(picked.id);
            setSupportTitle(picked.heading);
            setPicking(false);
            setFocusUpdate((count) => count + 1);
          }}
        />
      </PopoverContent>
    </Popover>
  );
  /** The editor an update's row becomes while it is edited (DB-08). */
  const editForm = (
    edit: { id: string; original: string; content: string },
    savedBrief: string,
  ) => (
    <form
      className="activity-edit"
      aria-label="Edit update"
      onSubmit={(event) => void saveEdit(event)}
      onKeyDown={submitKey}
    >
      {savedBrief !== edit.original && (
        <Alert tone="attention" size="compact" role="status">
          <AlertDescription>
            The saved update changed while you were editing.
          </AlertDescription>
          <AlertActions>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setEdit({
                  ...edit,
                  original: savedBrief,
                  content: savedBrief,
                })
              }
            >
              Use saved version
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEdit({ ...edit, original: savedBrief })}
            >
              Keep my draft
            </Button>
          </AlertActions>
        </Alert>
      )}
      <LazyMarkdownEditor
        attachmentTicketReference={reference}
        key={`${edit.id}:${edit.original}`}
        recoveryOwner={`activity-edit:${ticketId}`}
        label="Edit update"
        value={edit.content}
        onChange={(content) => setEdit({ ...edit, content })}
        readOnly={pending}
        chromeHost={editControlsHost}
        autoFocus
      />
      <div className="activity-composer-row">
        <span ref={setEditControlsHost} className="activity-controls" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setEdit(null)}
        >
          Cancel edit
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending || !hasVisibleText(edit.content)}
        >
          {pending ? "Saving…" : "Save update"}
        </Button>
      </div>
    </form>
  );
  return (
    <section
      className="activity"
      aria-label="Activity"
      hidden={
        foldEmpty &&
        !loading &&
        notes.length === 0 &&
        history.length === 0 &&
        !composing &&
        !edit &&
        !error &&
        !loadError &&
        !targetMissing
      }
    >
      {/* The note is only worth saying where a source owns the ticket and could be confused for the destination. */}
      <SectionHeader
        title="Activity"
        count={notes.length || undefined}
        caption={
          sourceName && <>Only in ticketd · never sent to {sourceName}</>
        }
        actions={
          <SegmentedControl
            aria-label="Show activity"
            compact
            value={view}
            onValueChange={setView}
            options={[
              { value: "all", label: "All" },
              { value: "updates", label: "Updates" },
            ]}
          />
        }
      />
      {targetMissing === targetId && targetId !== undefined && (
        <Alert size="compact">
          <AlertDescription>
            This update is no longer available.
          </AlertDescription>
          <Button variant="ghost" size="sm" onClick={() => void changed()}>
            Refresh updates
          </Button>
        </Alert>
      )}
      {!composing && error ? (
        <FailureAlert size="compact" failure={error} />
      ) : (
        loadError && (
          <FailureAlert
            size="compact"
            failure={loadError}
            onRetry={() => {
              if (activity.failure) activity.retry();
              if (note.failure) note.retry();
            }}
          />
        )
      )}
      {!trashed && (
        // One frame from the first frame (P16): idle it is a one-line field;
        // opened, it holds the editor and grows only downward as you type.
        <Card asChild variant="composer">
          <form
            ref={composerRef}
            className="activity-composer"
            data-open={composing || undefined}
            aria-label="Write an update"
            onFocusCapture={(event) => {
              if (!(event.target instanceof HTMLElement)) return;
              if (event.target.closest(".activity-details"))
                setControlsOwner("details");
              else if (event.target.closest(".markdown-editor"))
                setControlsOwner("brief");
            }}
            onSubmit={(event) => void post(event)}
            onKeyDown={submitKey}
          >
            {composing ? (
              <>
                <LazyMarkdownEditor
                  attachmentTicketReference={reference}
                  recoveryOwner={recoveryOwner}
                  label="New update"
                  placeholder="Write an update…"
                  value={draft}
                  onChange={setDraft}
                  readOnly={pending}
                  focusRequest={focusUpdate}
                  chromeHost={controlsOwner === "brief" ? controlsHost : null}
                  controlsHidden={controlsOwner !== "brief"}
                  paragraphAfterQuote
                />
                {showDetails && (
                  <div className="activity-details">
                    <span className="activity-details-label">
                      <span>Details</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setFocusDetails(false);
                          setControlsOwner("brief");
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
                    </span>
                    <LazyMarkdownEditor
                      attachmentTicketReference={reference}
                      chromeHost={
                        controlsOwner === "details" ? controlsHost : null
                      }
                      controlsHidden={controlsOwner !== "details"}
                      label="Details"
                      recoveryOwner={`${recoveryOwner}:details`}
                      placeholder="Technical notes, logs or Markdown. Kept as a Document with this update."
                      value={details}
                      onChange={setDetails}
                      readOnly={pending}
                      autoFocus={focusDetails}
                    />
                  </div>
                )}
                {support && (
                  <div className="activity-attached">
                    <Badge variant="record">
                      <FileText aria-hidden="true" />
                      <span className="truncate">
                        {supportTitle || "Document"}
                      </span>
                      <button
                        type="button"
                        data-slot="badge-remove"
                        aria-label="Remove attached Document"
                        onClick={() => setSupport("")}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </Badge>
                  </div>
                )}
                <FloatingEditBar
                  status={hasDraft(saved) ? "Draft saved" : ""}
                  controlsRef={setControlsHost}
                  feedback={
                    error && (
                      <FailureAlert
                        size="compact"
                        failure={error}
                        onRetry={() => composerRef.current?.requestSubmit()}
                      />
                    )
                  }
                  actions={
                    <>
                      {plus}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          if (hasDraft(saved)) clearDraft();
                          setPicking(false);
                          setComposing(false);
                        }}
                      >
                        {hasDraft(saved) ? "Discard draft" : "Cancel"}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => composerRef.current?.requestSubmit()}
                        size="sm"
                        disabled={pending || !hasText}
                        aria-describedby={!hasText ? postHintId : undefined}
                      >
                        {pending ? "Saving…" : "Post update"}
                        {!pending && (
                          <Kbd tone="inverted" aria-hidden="true">
                            {submitHint}
                          </Kbd>
                        )}
                      </Button>
                      <span id={postHintId} className="sr-only">
                        Write an update to post.
                      </span>
                    </>
                  }
                />
              </>
            ) : (
              <button
                type="button"
                className="activity-composer-idle"
                aria-keyshortcuts={ariaKeyShortcuts("ticket-update")}
                onClick={() => {
                  setComposing(true);
                  setFocusUpdate((count) => count + 1);
                }}
              >
                <span className="activity-composer-prompt">
                  <MessageSquare aria-hidden="true" />
                  <span>Write an update…</span>
                </span>
                <Kbd aria-hidden="true">{shortcutLabel("ticket-update")}</Kbd>
              </button>
            )}
          </form>
        </Card>
      )}
      {edit &&
        !displayedNotes.some((note) => note.id === edit.id) &&
        // A recovered edit of an update not on this page is never lost.
        editForm(edit, edit.original)}
      {loading && entries.length === 0 ? (
        <p className="activity-muted" role="status">
          Loading activity…
        </p>
      ) : entries.length === 0 && !error && !loadError ? (
        // The filter can hide the history alone: say what is really empty (DB-21).
        view === "updates" && history.length > 0 ? (
          <EmptyState
            size="inline"
            plain
            description="No updates yet."
            action={
              <Button
                variant="link"
                size="inline"
                onClick={() => setView("all")}
              >
                Show all activity
              </Button>
            }
          />
        ) : (
          <EmptyState
            size="inline"
            plain
            description="No updates or recorded changes yet."
          />
        )
      ) : (
        <Timeline aria-label="Activity timeline">
          {entries.map((item) =>
            item.type === "note" ? (
              <CommentRow
                key={`note-${item.note.id}`}
                icon={item.note.editing_agent ? Bot : MessageSquare}
                mark={
                  editingHarness(item.note.editing_agent) ? (
                    <HarnessMark
                      harness={editingHarness(item.note.editing_agent)}
                      name={item.note.editing_agent ?? ""}
                      decorative
                    />
                  ) : undefined
                }
                label={`Update by ${item.note.editing_agent ?? "you"}`}
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
                data-open={confirmDelete === item.note.id || undefined}
                header={
                  // One line: who · when · edited, then Latest (DB-12, DB-18).
                  <span className="activity-author">
                    <strong>{item.note.editing_agent ?? "You"}</strong>
                    <span aria-hidden="true">·</span>
                    <Time value={item.note.reported_at} />
                    {item.note.updated_at !== item.note.reported_at && (
                      <>
                        <span aria-hidden="true">·</span>
                        <Tooltip
                          content={`Edited ${formatDateTime(item.note.updated_at)}`}
                        >
                          <span tabIndex={0}>edited</span>
                        </Tooltip>
                      </>
                    )}
                    {item.note.id === (newestNoteId ?? latestNoteId) && (
                      <Badge size="sm">Latest</Badge>
                    )}
                  </span>
                }
                actions={
                  !trashed &&
                  edit?.id !== item.note.id && (
                    <UpdateActions
                      when={formatDateTime(item.note.reported_at)}
                      disabled={pending}
                      editing={Boolean(edit)}
                      confirming={confirmDelete === item.note.id}
                      hasDetails={Boolean(item.note.supporting_document_id)}
                      failure={deleteError}
                      onReply={() => reply(item.note.brief)}
                      onEdit={() =>
                        setEdit({
                          id: item.note.id,
                          original: item.note.brief,
                          content: item.note.brief,
                        })
                      }
                      onConfirm={(open) => {
                        if (open) setDeleteError(null);
                        setConfirmDelete(open ? item.note.id : null);
                      }}
                      onDelete={() => void remove(item.note.id)}
                      repliedRef={replied}
                      focusComposer={() => setFocusUpdate((count) => count + 1)}
                    />
                  )
                }
              >
                {edit?.id === item.note.id ? (
                  // Edit in place: the row's body becomes the editor (DB-08).
                  editForm(edit, item.note.brief)
                ) : (
                  <div
                    {...chatSource(`${reference} · Update`, {
                      kind: "ticket",
                      id: ticketId,
                    })}
                  >
                    <div className="markdown-preview activity-note">
                      <Clamp>
                        <MarkdownDocument
                          source={item.note.brief}
                          select={select}
                          revision={revision}
                        />
                      </Clamp>
                    </div>
                  </div>
                )}
                {item.note.supporting_document_id && (
                  <DetailsChip
                    info={detailDocuments[item.note.supporting_document_id]}
                    open={() =>
                      openDocument?.(item.note.supporting_document_id!)
                    }
                  />
                )}
              </CommentRow>
            ) : (
              <EventGroup
                key={`history-${item.id}`}
                icon={History}
                summary={changeSummary(item.changes)}
                time={<Time value={item.timestamp} format="compact" />}
              >
                {item.changes.map((entry, index) => (
                  <EventRow
                    key={index}
                    icon={historyIcon(entry.kind, entry.to_value)}
                    time={<Time value={entry.timestamp} format="compact" />}
                    meta={
                      entry.editing_agent && (
                        <span className="activity-agent">
                          {attribution(entry.editing_agent)}
                        </span>
                      )
                    }
                  >
                    {historySentence(entry, lookups)}
                  </EventRow>
                ))}
              </EventGroup>
            ),
          )}
        </Timeline>
      )}
      {activity.more && (
        <Pager
          noun="activity"
          loading={pending || activity.loadingMore}
          onMore={activity.showMore}
        />
      )}
    </section>
  );
}

/** A compact inventory of actual records; full values and attribution expand below. */
function changeSummary(changes: Entry[]): string {
  const counts = new Map<string, number>();
  for (const entry of changes) {
    const kind =
      entry.kind === "dependency" ||
      entry.kind === "parent" ||
      entry.kind.startsWith("relationship:")
        ? "link"
        : entry.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, count]) => {
    if (kind === "evidence")
      return `${count} ${count === 1 ? "piece" : "pieces"} of evidence`;
    if (kind === "link") return `${count} ${count === 1 ? "link" : "links"}`;
    if (kind === "status")
      return `status to ${changes.find((entry) => entry.kind === "status")?.to_value}`;
    if (kind === "plan") return "Plan";
    if (kind === "project") return "project";
    return `${count} ${count === 1 ? "other change" : "other changes"}`;
  });
  return `${changes.length} ${changes.length === 1 ? "change" : "changes"}: ${parts.join(", ")}`;
}

/**
 * An update's "…" (Reply, Edit update, Delete update), revealed on row hover
 * and focus. Delete asks in a small popover anchored to the same "…" (P7).
 */
function UpdateActions({
  when,
  disabled,
  editing,
  confirming,
  hasDetails,
  failure,
  onReply,
  onEdit,
  onConfirm,
  onDelete,
  repliedRef,
  focusComposer,
}: {
  when: string;
  disabled: boolean;
  editing: boolean;
  confirming: boolean;
  hasDetails: boolean;
  failure: FailureDescription | null;
  onReply: () => void;
  onEdit: () => void;
  onConfirm: (open: boolean) => void;
  onDelete: () => void;
  repliedRef: React.RefObject<boolean>;
  focusComposer: () => void;
}) {
  const requested = useRef(false);
  const [retainingTrigger, setRetainingTrigger] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="activity-row-actions"
      data-retained={retainingTrigger || undefined}
    >
      <Popover open={confirming} onOpenChange={onConfirm}>
        <DropdownMenu>
          <PopoverAnchor asChild>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={trigger}
                type="button"
                tooltipSide="top"
                disabled={disabled}
                label={`Actions for update from ${when}`}
              >
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
          </PopoverAnchor>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (requested.current) {
                requested.current = false;
                event.preventDefault();
                onConfirm(true);
                return;
              }
              // Focus goes to the composer, not back to the menu button.
              if (repliedRef.current) {
                event.preventDefault();
                repliedRef.current = false;
                focusComposer();
              }
            }}
          >
            <DropdownMenuItem disabled={editing} onSelect={onReply}>
              Reply
            </DropdownMenuItem>
            <DropdownMenuItem disabled={editing} onSelect={onEdit}>
              Edit update
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                requested.current = true;
              }}
            >
              Delete update
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <PopoverContent
          align="end"
          role="alertdialog"
          aria-label="Delete this update?"
          onCloseAutoFocus={(event) => {
            if (!preserveNewerFocus(event) && trigger.current?.isConnected) {
              event.preventDefault();
              trigger.current.focus({ preventScroll: true });
            }
            setRetainingTrigger(false);
          }}
          onOpenAutoFocus={(event) => {
            // Keep the return target exposed until the portalled exit finishes.
            setRetainingTrigger(true);
            // Cancel takes focus: a destructive answer is never the default.
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <p className="activity-confirm-title">Delete this update?</p>
          <p className="activity-confirm-text">
            {hasDetails
              ? "Its details stay in Documents."
              : "This can't be undone."}
          </p>
          {failure && (
            <FailureAlert size="compact" failure={failure} onRetry={onDelete} />
          )}
          <div className="activity-confirm-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              ref={cancel}
              data-cancel
              onClick={() => onConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={onDelete}
            >
              Delete update
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** An update's details: a Document chip named by what it holds (DB-14). */
function DetailsChip({
  info,
  open,
}: {
  info: { heading: string; trashed: boolean; attached: boolean } | undefined;
  open: () => void;
}) {
  return (
    <span className="activity-details-chip">
      <Badge variant="record" asChild>
        <button
          type="button"
          onClick={open}
          aria-label={
            info
              ? `${info.attached ? "Attached" : "Details"}: ${info.heading}`
              : "Open details"
          }
        >
          <FileText aria-hidden="true" />
          <span className="truncate">
            {info
              ? `${info.attached ? "Attached" : "Details"} · ${info.heading}`
              : "Details"}
          </span>
        </button>
      </Badge>
      {info?.trashed && <Badge size="sm">In Trash</Badge>}
    </span>
  );
}
