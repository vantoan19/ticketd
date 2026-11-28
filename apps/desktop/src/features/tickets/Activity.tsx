import { providerName } from "@/lib/api/sources";
import { useSources } from "@/features/settings/sources/use-sources";
import { preserveNewerFocus } from "@/components/ui/use-focus-return";
import { FloatingEditBar } from "@/features/markdown/FloatingEditBar";
import { onTicketUpdate } from "./activity-composer-request";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { useEditingHarness } from "@/features/chats/editing-harness";
import { Pager } from "@/components/ui/pager";
import { SectionHeader } from "@/components/ui/section-header";
import { Tooltip } from "@/components/ui/tooltip";
import { documents } from "@/features/documents/api";
import { DocumentPicker } from "./DocumentPicker";
import { hasVisibleText } from "./brief-text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DocumentNavigation } from "@/features/documents/navigation";
import {
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
  ChevronRight,
  FileText,
  History,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { m } from "motion/react";
import { Presence } from "@/components/ui/motion";
import { exitTransition } from "@/lib/motion-tokens";
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
import { changeSummary, historySentence } from "./history-sentence";
import type { Entry } from "@/lib/api/history";
import { historyIcon } from "./history-icon";
import { attribution } from "./ticket-source";
import type { CreditedSubAgent } from "@/lib/api/credit";
import { useChatFeature } from "@/features/chats/use-chats";
import { formatDateTime, plural } from "@/lib/format";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { revealInDetail } from "./detail-scroll";
import { z } from "zod";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { editedUpdateFills, useOpenTicket } from "./open-ticket";
import { updateClampLines } from "./update-clamp";
import { NewUpdateDot } from "./NewUpdateDot";
import { isNewUpdate } from "./ticket-seen-time";
import type { LatestUpdate } from "@/lib/api/progress";
import {
  DraftRecoveryGate,
  useDraftRecovery,
} from "@/lib/draft-recovery-context";
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
const activityViewKey = "ticketd:activity-view";
type ActivityView = "all" | "updates";
const activityViewChanged = "ticketd:activity-view-changed";
let unsavedActivityView: ActivityView | undefined;

function readActivityView(): ActivityView {
  return (
    unsavedActivityView ??
    (localValue(activityViewKey) === "all" ? "all" : "updates")
  );
}

function chooseActivityView(view: ActivityView) {
  try {
    localStorage.setItem(activityViewKey, view);
    unsavedActivityView = undefined;
  } catch {
    unsavedActivityView = view;
  }
  window.dispatchEvent(new Event(activityViewChanged));
}

function subscribeActivityView(change: () => void) {
  window.addEventListener(activityViewChanged, change);
  return () => window.removeEventListener(activityViewChanged, change);
}
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

type ActivityProps = {
  foldEmpty?: boolean;
  sourceName?: string | undefined;
  latestNoteId?: string | undefined;
  representedUpdate?: LatestUpdate | null;
  seenTime?: number | null;
  reference: string;
  ticketId?: string;
  projects: Project[];
  active: boolean;
  trashed: boolean;
  select?: (reference: string) => void;
  target?: { id: string; key: number } | null;
  plans?: Plan[];
};

/** Opens once stored recovery has loaded, so unsent updates come back with it. */
export function Activity(props: ActivityProps) {
  return (
    <DraftRecoveryGate>
      <RecoveredActivity {...props} />
    </DraftRecoveryGate>
  );
}

function RecoveredActivity({
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
  representedUpdate,
  seenTime = null,
  foldEmpty = false,
}: ActivityProps) {
  const editingHarness = useEditingHarness();
  const recovery = useDraftRecovery();
  const targetId = target?.id;
  const targetKey = target?.key;
  const recoveryOwner = `activity:${ticketId}`;
  const statusLine = useStatusLine();
  const submitHint = shortcutLabel("update-post");
  const composerPrompt = sourceName
    ? `Write an update · not posted to ${sourceName}`
    : "Write an update…";
  const [deleteError, setDeleteError] = useState<FailureDescription | null>(
    null,
  );
  const targetRef = useRef<HTMLLIElement>(null);
  const revealedTarget = useRef<{ id: string; key: number } | null>(null);
  const { changed, record } = useOpenTicket();
  // Unmigrated readers below (Documents, Markdown) still follow the change signal.
  const revision = useWorkspaceChange();
  const view = useSyncExternalStore(subscribeActivityView, readActivityView);
  const updates = useOpenTicket("activity", "updates", view === "updates");
  const readHistory = view === "updates" && updates.value?.length === 0;
  const all = useOpenTicket("activity", "all", view === "all" || readHistory);
  const activity = view === "updates" ? updates : all;
  const updateCount = useOpenTicket(
    "activityUpdateCount",
    view === "updates" && updates.more,
  );
  const note = useOpenTicket("activityNote", targetId);
  const targetNote: AuthoredActivity | null = note.value ?? null;
  // A target whose notice was dismissed by leaving the ticket stays dismissed
  // until a new target (a new key) is opened.
  const [leftTargetKey, setLeftTargetKey] = useState<number | undefined>();
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [wasActive, setWasActive] = useState(active);
  const [wasReference, setWasReference] = useState(reference);
  if (wasActive !== active || wasReference !== reference) {
    setWasActive(active);
    setWasReference(reference);
    if (!active || wasReference !== reference) {
      setLeftTargetKey(targetKey);
      setEarlierOpen(false);
    }
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
  const history = (readHistory ? (all.value ?? noFeed) : feed).flatMap(
    (item) => (item.type === "automatic" ? [item] : []),
  );
  const loading =
    (activity.value === undefined && activity.failure === null) ||
    (readHistory && all.value === undefined && all.failure === null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const loadError =
    activity.failure ??
    (readHistory ? all.failure : null) ??
    note.failure ??
    updateCount.failure;
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
    let reported: Promise<void> | null = null;
    try {
      await recovery.flush();
      if (edit) {
        const updated = await client.editActivity(
          reference,
          edit.id,
          edit.content,
        );
        // Reported as soon as it is saved, with the saved update: the pane
        // shows it through the cache whatever the draft store does next.
        reported = changed(undefined, editedUpdateFills(record, updated));
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
        // The edit is saved: a draft store that fails to drop its draft is not
        // a failure to save (the draft is dropped again when the editor closes).
        await recovery
          .put(`activity-edit:${ticketId}`, null, [])
          .catch(() => {});
        setEdit(null);
      } else {
        clearDraft();
        if (recovery.active) await recovery.put(requestKey, null, []);
        setComposing(false);
      }
      await (reported ?? changed());
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
  const availableNotes =
    active &&
    targetNote !== null &&
    targetId !== undefined &&
    targetNote.id === targetId &&
    !notes.some((note) => note.id === targetId)
      ? [...notes, targetNote]
      : notes;
  const sortedNotes = [...availableNotes].sort((a, b) =>
    b.reported_at.localeCompare(a.reported_at),
  );
  const latest = sortedNotes[0];
  // An explicit update link or a saved edit must still reach the full row.
  const stub =
    representedUpdate &&
    representedUpdate.activity_id !== targetId &&
    representedUpdate.activity_id !== edit?.id &&
    (!latest ||
      latest.id === representedUpdate.activity_id ||
      latest.reported_at < representedUpdate.reported_at)
      ? representedUpdate
      : null;
  const stubNote = sortedNotes.find((note) => note.id === stub?.activity_id);
  const remaining = sortedNotes.filter((note) => note.id !== stub?.activity_id);
  const recentNotes = remaining.slice(0, 3);
  const totalUpdates = updateCount.value ?? notes.length;
  const earlierCount = Math.max(
    0,
    totalUpdates - Number(Boolean(stubNote)) - recentNotes.length,
  );
  const moreEarlier =
    updates.more &&
    (updateCount.value === undefined || notes.length < updateCount.value);
  const { failedMore, loadingMore, showMore } = updates;
  useEffect(() => {
    if (
      active &&
      view === "updates" &&
      earlierOpen &&
      moreEarlier &&
      !failedMore &&
      !loadingMore
    )
      showMore();
  }, [
    active,
    view,
    earlierOpen,
    moreEarlier,
    failedMore,
    loadingMore,
    showMore,
  ]);
  const displayedNotes =
    view === "all"
      ? sortedNotes
      : earlierOpen
        ? remaining
        : remaining.filter(
            (note) =>
              recentNotes.includes(note) ||
              note.id === targetId ||
              note.id === edit?.id,
          );
  const firstEarlierNote = displayedNotes.find(
    (note) => !recentNotes.includes(note),
  );
  const detailIds = new Set(
    displayedNotes.flatMap((note) =>
      note.supporting_document_id ? [note.supporting_document_id] : [],
    ),
  );
  if (stub?.supporting_document_id) detailIds.add(stub.supporting_document_id);
  const detailIdsKey = [...detailIds].join(",");
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
  // Rows glide only when this changes, not on every keystroke in the composer.
  const order = entries
    .map((item) => (item.type === "note" ? `n${item.note.id}` : `h${item.id}`))
    .join();
  // An update newer than the newest already shown arrives with motion: yours
  // posted, or one an agent reports. The first list, older pages and a changed
  // filter appear without it.
  const newestEntry = entries[0]?.timestamp ?? null;
  // shownThrough is the newest entry of the list before this one.
  const [seenNewest, setSeenNewest] = useState<string | null>(null);
  const [shownThrough, setShownThrough] = useState<string | null>(null);
  if (newestEntry !== seenNewest) {
    setSeenNewest(newestEntry);
    setShownThrough(seenNewest);
  }
  const { entries: sources } = useSources();
  const lookups = {
    source: (id: string) => providerName(id, sources),
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
  const updateActions = {
    disabled: pending,
    editing: Boolean(edit),
    confirmingId: confirmDelete,
    failure: deleteError,
    onReply: reply,
    onEdit: (note: AuthoredActivity) =>
      setEdit({ id: note.id, original: note.brief, content: note.brief }),
    onConfirm: (id: string, open: boolean) => {
      if (open) setDeleteError(null);
      setConfirmDelete(open ? id : null);
    },
    onDelete: (id: string) => void remove(id),
    focusReplied: () => {
      if (!replied.current) return false;
      replied.current = false;
      setFocusUpdate((count) => count + 1);
      return true;
    },
  };
  const detailsFor = (id: string | null | undefined) =>
    id && (
      <DetailsChip info={detailDocuments[id]} open={() => openDocument?.(id)} />
    );
  const earlier = view === "updates" && earlierCount > 0 && (
    <li key="earlier" className="activity-earlier">
      <button
        type="button"
        className="ui-disclosure-trigger"
        aria-expanded={earlierOpen}
        onClick={() => setEarlierOpen(!earlierOpen)}
      >
        <ChevronRight aria-hidden="true" />
        <span>{plural(earlierCount, "earlier update")}</span>
      </button>
    </li>
  );
  const firstEarlierIndex = entries.findIndex(
    (entry) => entry.type === "note" && entry.note.id === firstEarlierNote?.id,
  );
  const earlierIndex =
    firstEarlierIndex < 0 ? entries.length : firstEarlierIndex;
  const firstNewIndex = entries.findIndex(
    (entry) =>
      entry.type === "note" &&
      entry.note.id !== stub?.activity_id &&
      isNewUpdate(entry.note, seenTime),
  );
  const rows = entries.map((item, index) =>
    item.type === "note" ? (
      item.note.id === stub?.activity_id ? null : (
        <Fragment key={`note-${item.note.id}`}>
          {index === firstNewIndex && (
            <li className="activity-new-divider activity-muted">
              <span>New since you last looked</span>
            </li>
          )}
          <CommentRow
            layoutDependency={order}
            arriving={shownThrough !== null && item.timestamp > shownThrough}
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
              active && item.note.id === targetId && targetNote?.id === targetId
                ? targetRef
                : undefined
            }
            tabIndex={
              active && item.note.id === targetId && targetNote?.id === targetId
                ? -1
                : undefined
            }
            aria-label={
              active && item.note.id === targetId && targetNote?.id === targetId
                ? "Selected update"
                : undefined
            }
            data-open={confirmDelete === item.note.id || undefined}
            header={
              // One line: who · when · edited, then Latest (DB-12, DB-18).
              <span className="activity-author">
                <strong>{item.note.editing_agent ?? "You"}</strong>
                <SubAgentCredit
                  credit={item.note.credited_to}
                  reference={reference}
                />
                <span aria-hidden="true">·</span>
                <Time value={item.note.reported_at} />
                {isNewUpdate(item.note, seenTime) && <NewUpdateDot />}
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
                <Presence initial={false}>
                  {item.note.id === (latest?.id ?? latestNoteId) && (
                    <m.span
                      key="latest"
                      exit={{ opacity: 0, transition: exitTransition() }}
                    >
                      <Badge size="sm">Latest</Badge>
                    </m.span>
                  )}
                </Presence>
              </span>
            }
            actions={
              !trashed &&
              edit?.id !== item.note.id && (
                <UpdateActions {...updateActions} note={item.note} />
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
                  <Clamp
                    lines={updateClampLines(
                      item.note.brief,
                      view === "updates" ? 6 : 8,
                    )}
                  >
                    <MarkdownDocument
                      source={item.note.brief}
                      select={select}
                      revision={revision}
                      attachmentCards
                    />
                  </Clamp>
                </div>
              </div>
            )}
            {detailsFor(item.note.supporting_document_id)}
          </CommentRow>
        </Fragment>
      )
    ) : (
      <EventGroup
        key={`history-${item.id}`}
        layoutDependency={order}
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
                <>
                  <span className="activity-agent">
                    {attribution(entry.editing_agent, sources)}
                  </span>
                  <SubAgentCredit
                    credit={entry.credited_to}
                    reference={reference}
                    after
                  />
                </>
              )
            }
          >
            {historySentence(entry, lookups)}
          </EventRow>
        ))}
      </EventGroup>
    ),
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
        !targetMissing &&
        !stub
      }
    >
      <SectionHeader
        level={2}
        title="Activity"
        // The read gives no total, so while more is waiting the count only
        // says how many updates are loaded so far.
        count={
          totalUpdates
            ? `${totalUpdates}${activity.more && updateCount.value === undefined ? "+" : ""}`
            : undefined
        }
        actions={
          <SegmentedControl
            aria-label="Show activity"
            compact
            value={view}
            onValueChange={chooseActivityView}
            options={[
              { value: "updates", label: "Updates" },
              { value: "all", label: "All" },
            ]}
          />
        }
      />
      {targetMissing === targetId && targetId !== undefined && (
        <Alert size="compact">
          <AlertDescription>
            This update is no longer available.
          </AlertDescription>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // The update is gone: the notice has been read, and the refresh
              // looks for what else changed.
              setLeftTargetKey(targetKey);
              void changed();
            }}
          >
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
              if (readHistory && all.failure) all.retry();
              if (note.failure) note.retry();
              if (updateCount.failure) updateCount.retry();
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
                  placeholder={composerPrompt}
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
                  <span>{composerPrompt}</span>
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
      {stub && (
        <div
          className="activity-latest-stub activity-muted"
          data-open={confirmDelete === stub.activity_id || undefined}
        >
          <p>
            ↑ Latest update, <Time value={stub.reported_at} />, is shown above
          </p>
          {detailsFor(stub.supporting_document_id)}
          {!trashed && stubNote && (
            <UpdateActions {...updateActions} note={stubNote} />
          )}
        </div>
      )}
      {loading && entries.length === 0 && !stub ? (
        <p className="activity-muted" role="status">
          Loading activity…
        </p>
      ) : entries.length === 0 && !stub && !error && !loadError ? (
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
                onClick={() => chooseActivityView("all")}
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
        (rows.some(Boolean) || earlier) && (
          <Timeline aria-label="Activity timeline">
            {rows.slice(0, earlierIndex)}
            {earlier}
            {rows.slice(earlierIndex)}
          </Timeline>
        )
      )}
      {view === "updates" && earlierOpen && moreEarlier && !failedMore && (
        <p className="activity-muted" role="status">
          Loading earlier updates…
        </p>
      )}
      {view === "all" && activity.more && (
        <Pager
          noun="activity"
          loading={pending || activity.loadingMore}
          onMore={activity.showMore}
        />
      )}
    </section>
  );
}

/**
 * "bot {sub-agent title}" after an author: the sub-agent a change is credited
 * to, which opens its view in its Chat. Only where the host knows the Chat (it
 * is on this computer) and Chat is on.
 */
function SubAgentCredit({
  credit,
  reference,
  after = false,
}: {
  credit: CreditedSubAgent | null | undefined;
  reference: string;
  /** In a recorded change's meta, where the separator is spaced text rather than a flex gap. */
  after?: boolean;
}) {
  const { enabled, requestChat } = useChatFeature();
  if (!credit || !enabled) return null;
  return (
    <>
      <span aria-hidden="true">{after ? " · " : "·"}</span>
      <button
        type="button"
        className="activity-subagent"
        onClick={() =>
          requestChat({
            kind: "open",
            chatId: credit.chat_id,
            retention: credit.retention,
            from: reference,
            subAgent: credit.sub_agent,
          })
        }
      >
        <Bot aria-hidden="true" />
        <span>{credit.title}</span>
      </button>
    </>
  );
}

/**
 * An update's "…" (Reply, Edit update, Delete update), revealed on row hover
 * and focus. Delete asks in a small popover anchored to the same "…" (P7).
 */
function UpdateActions({
  note,
  disabled,
  editing,
  confirmingId,
  failure,
  onReply,
  onEdit,
  onConfirm,
  onDelete,
  focusReplied,
}: {
  note: AuthoredActivity;
  disabled: boolean;
  editing: boolean;
  confirmingId: string | null;
  failure: FailureDescription | null;
  onReply: (brief: string) => void;
  onEdit: (note: AuthoredActivity) => void;
  onConfirm: (id: string, open: boolean) => void;
  onDelete: (id: string) => void;
  focusReplied: () => boolean;
}) {
  const confirm = (open: boolean) => onConfirm(note.id, open);
  const remove = () => onDelete(note.id);
  const requested = useRef(false);
  const [retainingTrigger, setRetainingTrigger] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="activity-row-actions"
      data-retained={retainingTrigger || undefined}
    >
      <Popover open={confirmingId === note.id} onOpenChange={confirm}>
        <DropdownMenu>
          <PopoverAnchor asChild>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={trigger}
                type="button"
                tooltipSide="top"
                disabled={disabled}
                label={`Actions for update from ${formatDateTime(note.reported_at)}`}
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
                confirm(true);
                return;
              }
              // Focus goes to the composer, not back to the menu button.
              if (focusReplied()) event.preventDefault();
            }}
          >
            <DropdownMenuItem
              disabled={editing}
              onSelect={() => onReply(note.brief)}
            >
              Reply
            </DropdownMenuItem>
            <DropdownMenuItem disabled={editing} onSelect={() => onEdit(note)}>
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
            {note.supporting_document_id
              ? "Its details stay in Documents."
              : "This can't be undone."}
          </p>
          {failure && (
            <FailureAlert size="compact" failure={failure} onRetry={remove} />
          )}
          <div className="activity-confirm-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              ref={cancel}
              data-cancel
              onClick={() => confirm(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={remove}
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
