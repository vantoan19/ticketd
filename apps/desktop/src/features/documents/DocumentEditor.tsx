import { useDialogPresence } from "@/components/ui/use-dialog-presence";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CloudCheck,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Info,
  Layers,
  Maximize2,
  PanelLeftOpen,
  CircleDashed,
  Link2,
  MoreHorizontal,
  Network,
  Pin,
  SquarePen,
  Tag,
  X,
} from "lucide-react";
import {
  readCaptureTextDraft,
  keepCaptureTextDraft,
  clearCaptureTextDraft,
} from "./capture-text-recovery";
import { attachments as workspaceAttachments } from "@/lib/api/attachments";
import { writeClipboard } from "@/lib/clipboard";
import { client } from "@/lib/api/client";
import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Skeleton } from "@/components/ui/skeleton";
import { IconButton } from "@/components/ui/icon-button";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Reference } from "@/components/ui/reference";
import { Input } from "@/components/ui/input";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Tooltip } from "@/components/ui/tooltip";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { outlineOf, showsOutline } from "@/features/markdown/outline";
import { flushSync } from "react-dom";
import { DocumentOutline } from "./DocumentOutline";
import { DocumentRail } from "./DocumentRail";
import { useSectionFolds } from "./section-folds";
import { headingElement, useCurrentHeading } from "./use-current-heading";
import { chatSource } from "@/features/chats/quotes";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { useMarkdownExport } from "@/features/attachments/use-markdown-export";
import { Kbd } from "@/components/ui/kbd";
import { FloatingEditBar } from "@/features/markdown/FloatingEditBar";
import { Disclosure } from "@/components/ui/disclosure";
import { plural } from "@/lib/format";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { documentLinkMarkdown } from "./document-link";
import { documents, type Document, type DocumentSummary } from "./api";
import { DocumentMeta } from "./DocumentMeta";
import { readingMinutes } from "./reading-time";
import { DocumentDetails } from "./DocumentDetails";
import { LinkedItems } from "./DocumentLinked";
import {
  useOnWorkspaceChange,
  useWorkspaceChange,
} from "@/lib/workspace-change";
import { DocumentNavigation, PlanNavigation } from "./navigation";
import { z } from "zod";
import { StatusDot } from "@/components/ui/status-dot";
import { NeedsReviewNotice } from "@/features/sync-review/NeedsReviewNotice";
import { RecordHistory } from "@/features/sync-review/RecordHistory";
import { useConflicts } from "@/features/sync-review/use-conflicts";
import {
  DraftRecoveryGate,
  useDraftRecovery,
} from "@/lib/draft-recovery-context";
import { useRecordSyncState } from "@/features/sync/record-sync";

/**
 * A Document reads in the workspace; Capture uses the shared shell's floating
 * card variant. Save state stays in the header, context in the footer, and a
 * failed save keeps the same editor and recovery decisions in place.
 */
function DocumentSurface({
  capture,
  open,
  onExitComplete,
  onClose,
  onDismiss,
  footer,
  note,
  error,
  children,
}: {
  footer: ReactNode;
  capture: boolean;
  open: boolean;
  onExitComplete: () => void;
  /** Submit: save, then close. */
  onClose: () => void;
  /** The X and Escape use the same save and draft-protection controller. */
  onDismiss: () => void;
  note: ReactNode;
  error: ReactNode;
  children: ReactNode;
}) {
  if (!capture)
    return <article className="document-workspace">{children}</article>;
  return (
    <DialogShell
      open={open}
      onExitComplete={onExitComplete}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      title="New Document"
      variant="capture"
      headerActions={note}
      footerLeading={footer}
      primaryLabel={null}
      blockedReason={null}
      footerNote={
        <>
          <span>Kept in Documents</span> <Kbd>esc</Kbd>
        </>
      }
      error={error}
      onSubmit={onClose}
    >
      {children}
    </DialogShell>
  );
}
type Snapshot = {
  title: string;
  body: string;
  suggestion: string | null;
  /** The one-line summary as typed; "" is none. */
  summary: string;
};
const plain = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** A derived heading repeats the body's first line; the reader shows it once, as the heading. */
function withoutDerivedHeading(body: string, title: string, heading?: string) {
  const explicit = title.trim();
  if (!explicit && !heading) return body;
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim());
  const line = first < 0 ? "" : (lines[first] ?? "");
  // An explicit title is the heading; a body H1 that only repeats it is not shown twice.
  if (explicit && !/^#{1,6}\s/.test(line)) return body;
  const want = plain(explicit || heading || "");
  if (!want || !plain(line).startsWith(want.slice(0, 120))) return body;
  if (explicit && plain(line.replace(/^#{1,6}\s+/, "")) !== want) return body;
  return lines
    .slice(first + 1)
    .join("\n")
    .replace(/^\s*\n/, "");
}
/**
 * What Read renders: the body without an opening heading the title already
 * shows. Beyond the equal heading Edit also hides, an opening H1 that is only
 * the start of the title is dropped, so the title is never seen twice. Edit and
 * the stored Markdown keep that H1.
 */
function withoutOpeningTitle(body: string, title: string, heading?: string) {
  const shown = withoutDerivedHeading(body, title, heading);
  if (shown !== body) return shown;
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim());
  const opening = /^#\s+(.*)$/.exec(first < 0 ? "" : (lines[first] ?? ""));
  const start = plain(opening?.[1] ?? "");
  const full = plain(title.trim() || heading || "");
  if (!start || !full.startsWith(start)) return body;
  return lines
    .slice(first + 1)
    .join("\n")
    .replace(/^\s*\n/, "");
}
/** The core stores a whitespace-only title as NULL; the saved baseline must match what it stored. */
const storedTitle = (title: string) => (title.trim() ? title : "");
/** The core stores a summary trimmed on one line, and nothing when it is blank. */
const storedSummary = (summary: string) => summary.replace(/\s+/g, " ").trim();
type Pending = {
  id: string | null;
  title: string | null;
  body: string | null;
  titleChanged: boolean;
  /** The summary to store, "" to clear it; null leaves the stored one. */
  summary: string | null;
  requestId: string;
  snapshot: Snapshot;
  /** The stored revision this save was based on; the core rejects it if that moved on. */
  revision: string | null;
};
const snapshotSchema = z.object({
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
  // A draft kept before Documents had summaries has none.
  summary: z.string().default(""),
});
const pendingSchema = z.object({
  id: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  titleChanged: z.boolean(),
  summary: z.string().nullable().default(null),
  requestId: z.string(),
  snapshot: snapshotSchema,
  revision: z.string().nullable(),
});
const recoverySchema = z.object({
  draft: snapshotSchema,
  saved: snapshotSchema,
  id: z.string().nullable(),
  revision: z.string().nullable(),
  pending: pendingSchema.nullable(),
  discarded: snapshotSchema.nullable(),
  external: snapshotSchema.nullable(),
  externalRevision: z.string().nullable(),
});
/**
 * Where the reader sits in the Documents screen: beside the list or at full
 * width, and, at full width, the Document's place in the list it was opened from.
 */
export type DocumentReading = {
  expanded: boolean;
  /** Hides the list (full width) or brings it back (beside the list). */
  onExpandedChange: (expanded: boolean) => void;
  /** The place in the list as it shows now; null when the Document is not in it. */
  place: { index: number; total: number } | null;
  /** The Documents before and after this one in the list, if any. */
  previous: string | null;
  next: string | null;
  /** The button the reader should focus when it opens, because the reader stepped with it. */
  focus: "previous" | "next" | null;
  onFocused: () => void;
  onStep: (id: string, direction: "previous" | "next") => void;
};
type DocumentEditorProps = {
  initial: Document | null;
  reading?: DocumentReading;
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
  /** Bumped by the host (sidebar "Documents") to ask the reader to save and return to the list. */
  closeRequest?: number;
  /** Label of the reader's footer button; the Documents list says where it returns to. */
  backLabel?: string;
  children?: ReactNode | ((state: { trashed: boolean }) => ReactNode);
};

/** Opens once stored recovery has loaded, so an unsaved draft comes back with it. */
export function DocumentEditor(props: DocumentEditorProps) {
  return (
    <DraftRecoveryGate>
      <RecoveredDocumentEditor {...props} />
    </DraftRecoveryGate>
  );
}

function RecoveredDocumentEditor({
  initial,
  reading,
  onClose,
  currentTicket,
  onOpenDocument,
  onOpenTicket,
  onOpenPlan,
  onOpenGraph,
  active = true,
  pinned = false,
  onTogglePin,
  closeRequest = 0,
  backLabel = "Back to work",
  children,
}: DocumentEditorProps) {
  const { conflicts } = useConflicts();
  const needsReview = conflicts.some(
    (item) => item.kind === "document" && item.id === initial?.id,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  // The floating bar's controls slot, where the editor puts its formatting.
  const [sessionHost, setSessionHost] = useState<HTMLSpanElement | null>(null);
  const recovery = useDraftRecovery();
  const fallbackWorkspace = useRef<string | null>(null);
  const [restoringCapture, setRestoringCapture] = useState(!initial);
  const recoveryOwner = `document:${initial?.id ?? "capture"}`;
  const [recovered] = useState(() =>
    recovery.read(recoveryOwner, recoverySchema),
  );
  // Referenced tickets shown inside the Document (their Trash state) follow workspace changes.
  const workspaceRevision = useWorkspaceChange();
  const [focusRequest, setFocusRequest] = useState(0);
  const refocusEditor = () => setFocusRequest((value) => value + 1);
  const [writing, setWriting] = useState(
    initial === null || recovered !== null,
  );
  // The heading line the title already shows, kept out of the editor while editing
  // and put back in front of what is typed, so the saved text never changes.
  const [hiddenHead, setHiddenHead] = useState(() => {
    if (!recovered || !initial) return "";
    const { body, title } = recovered.draft;
    const stripped = withoutDerivedHeading(body, title, initial.heading);
    return body.slice(0, body.length - stripped.length);
  });
  const [ticketTitle, setTicketTitle] = useState("");
  const [links, setLinks] = useState<
    Awaited<ReturnType<typeof documents.links>>
  >([[], []]);
  const [linkError, setLinkError] = useState<FailureDescription | null>(null);
  // The same row the list shows (Plans with Archived ones, tickets, tags), read for this Document.
  const [row, setRow] = useState<DocumentSummary | null>(null);
  const rowKey = useRef("");
  // The "…" menu opens one panel at a time, anchored to the menu's button.
  const [panel, setPanel] = useState<
    "details" | "tags" | "link" | "ticket" | null
  >(null);
  const [newTag, setNewTag] = useState("");
  const [actionError, setActionError] = useState<FailureDescription | null>(
    null,
  );
  const [suggestion, setSuggestion] = useState(
    recovered ? recovered.draft.suggestion : (currentTicket ?? null),
  );
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
        .catch((error: unknown) =>
          setLinkError(describeFailure(error, "load the connections")),
        );
    if (initial)
      void documents
        .row(initial.id)
        .then((next) => {
          const key = JSON.stringify(next);
          if (key === rowKey.current) return;
          rowKey.current = key;
          setRow(next);
        })
        .catch(() => {});
  };
  const refreshLinksRef = useRef(refreshLinks);
  useEffect(() => {
    refreshLinksRef.current = refreshLinks;
  });
  useEffect(() => {
    refreshLinksRef.current();
  }, [initial]);
  const [title, setTitle] = useState(
    recovered?.draft.title ?? initial?.title ?? "",
  );
  const [body, setBody] = useState(
    recovered?.draft.body ?? initial?.body ?? "",
  );
  const [summary, setSummary] = useState(
    recovered?.draft.summary ?? initial?.summary ?? "",
  );
  const [status, setStatus] = useState(
    initial ? "Saved on this computer" : "Start writing. We’ll save as you go.",
  );
  const [savedDocument, setSavedDocument] = useState(initial);
  const [trashed, setTrashed] = useState(initial?.trashed ?? false);
  const [transitioning, setTransitioning] = useState(false);
  const transition = useRef<{ trashed: boolean; requestId: string } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [createError, setCreateError] = useState<FailureDescription | null>(
    null,
  );
  // A close or navigation that waited on a save that failed: the person may
  // still leave, keeping the draft on this device.
  const [leaveBlocked, setLeaveBlocked] = useState<(() => void) | null>(null);
  const [failedTrash, setFailedTrash] = useState(false);
  // Where a person tried to go after a failed save, when recovery could not keep the draft.
  const [copyResult, setCopyResult] = useState("");
  const [draftAtRisk, setDraftAtRisk] = useState<(() => void) | null>(null);
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
  const [external, setExternal] = useState<Snapshot | null>(
    recovered?.external ?? null,
  );
  // The draft "Reload saved content" threw away, offered back for a few seconds.
  const [discarded, setDiscarded] = useState<Snapshot | null>(
    recovered?.discarded ?? null,
  );
  useEffect(() => {
    if (!discarded) return;
    const timer = window.setTimeout(() => setDiscarded(null), 10000);
    return () => window.clearTimeout(timer);
  }, [discarded]);
  const externalRef = useRef<Snapshot | null>(recovered?.external ?? null);
  const draft = useRef<Snapshot>({ title, body, suggestion, summary });
  // The editor holds typing it has not reported yet: an outside change must
  // not replace the body meanwhile.
  const editorPending = useRef(false);
  const saved = useRef<Snapshot>(
    recovered?.saved ?? {
      title,
      body,
      suggestion: null,
      summary: storedSummary(initial?.summary ?? ""),
    },
  );
  const id = useRef(recovered?.id ?? initial?.id ?? null);
  const pending = useRef<Pending | null>(recovered?.pending ?? null);
  const saving = useRef(false);
  // `updated_at` of the stored Document as last loaded or saved here.
  const revision = useRef<string | null>(
    recovered?.revision ?? initial?.updated_at ?? null,
  );
  const externalRevision = useRef<string | null>(
    recovered?.externalRevision ?? null,
  );
  const recoveryPayload = () => {
    const dirty =
      storedTitle(draft.current.title) !== saved.current.title ||
      storedSummary(draft.current.summary) !== saved.current.summary ||
      draft.current.body !== saved.current.body ||
      draft.current.suggestion !== saved.current.suggestion;
    const payload =
      dirty || pending.current || discarded || externalRef.current
        ? {
            draft: draft.current,
            saved: saved.current,
            id: id.current,
            revision: revision.current,
            pending: pending.current,
            discarded,
            external: externalRef.current,
            externalRevision: externalRevision.current,
          }
        : null;
    return payload;
  };
  const persistRecovery = () => {
    const payload = recoveryPayload();
    return recovery.put(
      recoveryOwner,
      payload,
      payload
        ? [
            draft.current.body,
            pending.current?.snapshot.body ?? "",
            discarded?.body ?? "",
          ].filter(Boolean)
        : [],
    );
  };
  // The payload reads refs that change together with this state: the draft
  // (title, body, suggestion), Reload's offer, the outside change, and a save
  // or refresh (savedDocument, status).
  const persistChanged = useEffectEvent(() => {
    void persistRecovery().catch(() => {});
  });
  useEffect(
    () => persistChanged(),
    [
      recovery,
      title,
      body,
      summary,
      suggestion,
      discarded,
      external,
      savedDocument,
      status,
    ],
  );
  useEffect(() => {
    if (initial) return;
    let active = true;
    void workspaceAttachments
      .workspaceId()
      .then((workspaceId) => {
        if (!active) return null;
        fallbackWorkspace.current = workspaceId;
        return recovered ? null : readCaptureTextDraft(workspaceId);
      })
      .then((value) => {
        if (!active || !value || draft.current.body || draft.current.title)
          return;
        const result = recoverySchema.safeParse(value);
        if (!result.success) return;
        const snapshot = result.data;
        draft.current = snapshot.draft;
        saved.current = snapshot.saved;
        id.current = snapshot.id;
        pending.current = snapshot.pending;
        revision.current = snapshot.revision;
        externalRef.current = snapshot.external;
        externalRevision.current = snapshot.externalRevision;
        setTitle(snapshot.draft.title);
        setBody(snapshot.draft.body);
        setSummary(snapshot.draft.summary);
        setSuggestion(snapshot.draft.suggestion);
        setExternal(snapshot.external);
        setDiscarded(snapshot.discarded);
        setStatus("Draft restored");
      })
      .catch(() => {})
      .finally(() => {
        if (active) setRestoringCapture(false);
      });
    return () => {
      active = false;
      fallbackWorkspace.current = null;
    };
  }, [initial, recovered]);
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
  const presence = useDialogPresence(onClose, !initial);
  const close = useRef(initial ? onClose : presence.close);
  useEffect(() => {
    close.current = initial ? onClose : presence.close;
  }, [initial, onClose, presence.close]);
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
      setFailure(
        describeFailure(
          error,
          failedTransition.current?.trashed ? "move it to Trash" : "restore it",
        ),
      );
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
    const summaryChanged =
      storedSummary(snapshot.summary) !== saved.current.summary;
    const bodyChanged =
      snapshot.body !== saved.current.body ||
      snapshot.suggestion !== saved.current.suggestion;
    if (!pending.current && !titleChanged && !summaryChanged && !bodyChanged) {
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
      summary: summaryChanged ? storedSummary(snapshot.summary) : null,
      requestId: crypto.randomUUID(),
      snapshot,
      revision: revision.current,
    };
    pending.current = request;
    saving.current = true;
    setStatus("Saving…");
    setFailed(false);
    setDraftAtRisk(null);
    setLeaveBlocked(null);
    const slow = window.setTimeout(() => setStatus("Still saving…"), 2000);
    try {
      // Flush first: an explicit save clears a latched recovery failure, so the
      // put below is not rejected with the stale error after access returns.
      await recovery.flush();
      await persistRecovery();
      await recovery.flush();
      const result = await documents.save(
        request.id,
        request.title,
        request.body,
        request.titleChanged,
        request.revision,
        request.requestId,
        request.summary ?? undefined,
      );
      window.clearTimeout(slow);
      id.current = result.id;
      revision.current = result.updated_at;
      lastVersion.current = `${result.updated_at}|${result.trashed}`;
      setSavedDocument(result);
      saved.current = {
        ...request.snapshot,
        title: storedTitle(request.snapshot.title),
        // A request that left the summary alone keeps what was stored before it.
        summary:
          request.summary === null
            ? saved.current.summary
            : storedSummary(request.snapshot.summary),
      };
      pending.current = null;
      await persistRecovery();
      saving.current = false;
      setStatus("Saved on this computer");
      if (!initial && fallbackWorkspace.current)
        void clearCaptureTextDraft(fallbackWorkspace.current).catch(() => {});
      refreshLinks();
      if (
        storedTitle(draft.current.title) !== saved.current.title ||
        storedSummary(draft.current.summary) !== saved.current.summary ||
        draft.current.body !== saved.current.body ||
        draft.current.suggestion !== saved.current.suggestion
      )
        void save();
      else if (transition.current) void finishTransition();
      else if (closeRequested.current) finish();
    } catch (error) {
      window.clearTimeout(slow);
      saving.current = false;
      const leaving = closeRequested.current
        ? (afterSave.current ?? close.current)
        : null;
      closeRequested.current = false;
      afterSave.current = null;
      transition.current = null;
      if (toFailure(error).kind === "conflict" && id.current) {
        // The stored Document moved on since it was loaded: keep the draft and let
        // the conflict notice decide. If nothing differs, retry on the new revision.
        try {
          const latest = await documents.show(id.current);
          pending.current = null;
          if (reconcile(latest)) {
            setStatus("Saved on this computer");
            void save();
          } else setFailed(false);
          return;
        } catch {
          /* Fall through to the ordinary failure below. */
        }
      }
      setFailed(true);
      setFailedTrash(false);
      setFailure(describeFailure(error, "save the Document"));
      // Closing never waits on a save that keeps failing (DR-08).
      setLeaveBlocked(() => leaving);
      setStatus("Not saved");
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const failedRef = useRef(false);
  useEffect(() => {
    failedRef.current = failed;
  }, [failed]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // A failed save is retried by Retry, or by the next change; autosave
      // never repeats the very same request on its own.
      if (failedRef.current && pending.current?.snapshot === draft.current)
        return;
      void saveRef.current();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [title, body, summary, suggestion]);
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
      summary: storedSummary(document.summary ?? ""),
    };
    const settle = () => {
      revision.current = document.updated_at;
      // A resolved or merged outside change always clears the notice.
      externalRef.current = null;
      setExternal(null);
      setBlockedLeaving(false);
    };
    if (
      next.title === saved.current.title &&
      next.summary === saved.current.summary &&
      next.body === saved.current.body
    ) {
      settle();
      return true;
    }
    const titleDirty = storedTitle(draft.current.title) !== saved.current.title;
    const summaryDirty =
      storedSummary(draft.current.summary) !== saved.current.summary;
    const bodyDirty =
      editorPending.current ||
      draft.current.body !== saved.current.body ||
      draft.current.suggestion !== saved.current.suggestion;
    const conflict =
      (titleDirty && next.title !== saved.current.title) ||
      (summaryDirty && next.summary !== saved.current.summary) ||
      (bodyDirty &&
        (next.body !== saved.current.body ||
          next.suggestion !== saved.current.suggestion));
    if (conflict || pending.current) {
      // Preserve unrelated saved-field changes when the person chooses to
      // save over a conflicting field.
      if (titleDirty || summaryDirty || bodyDirty) {
        if (!titleDirty) {
          draft.current = { ...draft.current, title: next.title };
          saved.current = { ...saved.current, title: next.title };
          setTitle(next.title);
        }
        if (!summaryDirty) {
          draft.current = { ...draft.current, summary: next.summary };
          saved.current = { ...saved.current, summary: next.summary };
          setSummary(next.summary);
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
      setStatus("Not saved — changed elsewhere");
      return false;
    }
    // Nothing unsaved is at risk: refresh silently, keeping any unrelated dirty field.
    draft.current = {
      title: titleDirty ? draft.current.title : next.title,
      body: bodyDirty ? draft.current.body : next.body,
      suggestion: bodyDirty ? draft.current.suggestion : next.suggestion,
      summary: summaryDirty ? draft.current.summary : next.summary,
    };
    saved.current = next;
    settle();
    if (!titleDirty) setTitle(next.title);
    if (!summaryDirty) setSummary(next.summary);
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
  /** Reads the stored Document again and folds it in when it changed. */
  const refreshStored = () => {
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
  };
  // Another writer may have changed this Document or its links: look only when
  // the workspace says something changed.
  useOnWorkspaceChange(refreshStored, active);
  // While the conflict notice is up, clicks that would leave or Trash the Document are
  // ignored (not queued), so they cannot fire later after the person resolves it.
  const noticeRef = useRef<HTMLDivElement>(null);
  const [blockedLeaving, setBlockedLeaving] = useState(false);
  const blockWhileConflicted = () => {
    if (!externalRef.current) return false;
    setBlockedLeaving(true);
    noticeRef.current?.focus();
    // A click's own focus change can land after this handler; keep the notice focused.
    window.requestAnimationFrame(() => noticeRef.current?.focus());
    return true;
  };
  // After a failed save, waiting for the next save would trap the person in the
  // editor. Leaving keeps the draft in recovery instead, so it comes back on reopen;
  // only when that store cannot keep it either does leaving need a decision.
  const leaveKeepingDraft = async (action: () => void) => {
    try {
      if (!recovery.active) throw new Error("Draft recovery is unavailable");
      await recovery.flush();
      await persistRecovery();
      await recovery.flush();
    } catch {
      try {
        if (initial || !fallbackWorkspace.current)
          throw new Error("Document recovery requires workspace protection");
        await keepCaptureTextDraft(
          fallbackWorkspace.current,
          recoveryPayload(),
        );
      } catch {
        setDraftAtRisk(() => action);
        return;
      }
    }
    closeRequested.current = false;
    afterSave.current = null;
    action();
  };
  const leave = (action: () => void) => {
    if (blockWhileConflicted()) return;
    if (failed && !saving.current) {
      void leaveKeepingDraft(action);
      return;
    }
    afterSave.current = action;
    closeRequested.current = true;
    void save();
  };
  const navigate = (action: () => void) => leave(action);
  const requestCloseRef = useRef(() => {});
  const requestClose = () => leave(() => close.current());
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });
  const startTransition = (next: { trashed: boolean; requestId: string }) => {
    if (blockWhileConflicted()) return;
    transition.current = next;
    // Restore doesn't wait for the draft: it can't be saved while in Trash.
    if (trashedRef.current) void finishTransition();
    else void save();
  };
  const seenCloseRequest = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest === seenCloseRequest.current) return;
    seenCloseRequest.current = closeRequest;
    requestCloseRef.current();
  }, [closeRequest]);
  const toggleTrash = () =>
    startTransition({ trashed: !trashed, requestId: crypto.randomUUID() });
  const retry = () => {
    setDraftAtRisk(null);
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
  // What Read renders, and the outline of it: the headings people can jump to.
  const readSource = withoutOpeningTitle(body, title, savedDocument?.heading);
  const outline = useMemo(() => outlineOf(readSource), [readSource]);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const folds = useSectionFolds(initial?.id ?? null, outline);
  const { current: currentAnchor, goTo } = useCurrentHeading(
    scroller,
    outline,
    folds.folded,
  );
  /** Changes the folds and keeps the heading the reader is at where it was on screen. */
  const keepPlace = (change: () => void) => {
    const here =
      scroller && currentAnchor && headingElement(scroller, currentAnchor);
    const before = here ? here.getBoundingClientRect().top : 0;
    flushSync(change);
    const moved = here ? here.getBoundingClientRect().top - before : 0;
    if (scroller && moved !== 0) scroller.scrollBy(0, moved);
  };
  const expanded = reading?.expanded ?? false;
  const expandButton = useRef<HTMLButtonElement>(null);
  const showListButton = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  // The control the pointer or keys just used leaves the bar; focus moves to its counterpart.
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (expanded ? showListButton : expandButton).current?.focus();
  }, [expanded]);
  const stepped = reading?.focus ?? null;
  useEffect(() => {
    if (!stepped) return;
    // The reader that stepped is replaced by this one: the same button takes focus again.
    // At the end of the list the button is off, and its opposite takes the focus.
    const button = (stepped === "next" ? nextButton : previousButton).current;
    const other = (stepped === "next" ? previousButton : nextButton).current;
    (button && !button.disabled ? button : other)?.focus();
    reading?.onFocused();
    // Only at the reader's first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const railShown = expanded && !writing && showsOutline(outline);
  // The heading line left out of the editor, while the body still starts with it.
  const head =
    writing && hiddenHead && body.startsWith(hiddenHead) ? hiddenHead : "";
  /** Opens or closes editing; the heading line the title shows stays out of the editor. */
  const setEditing = (edit: boolean) => {
    const stripped = withoutDerivedHeading(body, title, savedDocument?.heading);
    setHiddenHead(
      edit && initial ? body.slice(0, body.length - stripped.length) : "",
    );
    setWriting(edit);
  };
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const markdownExport = useMarkdownExport(
    { kind: "markdown", body },
    actionsTrigger,
  );
  // E edits the Document in view, unless typing or another surface has focus.
  const editTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!initial) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "e" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const button = editTrigger.current;
      if (!button || !active || button.closest("[hidden]")) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]",
        )
      )
        return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [initial, active]);
  const titleInput = (
    <Input
      id="document-title"
      aria-label="Title"
      variant={capture ? "capture-title" : "title"}
      placeholder={capture ? "Document title" : "Title"}
      readOnly={locked || restoringCapture}
      value={title || (head ? heading : "")}
      onChange={(event) => {
        draft.current = { ...draft.current, title: event.target.value };
        setTitle(event.target.value);
      }}
    />
  );
  const [fadedStatus, setFadedStatus] = useState<string | null>(null);
  const [previousStatus, setPreviousStatus] = useState(status);
  if (previousStatus !== status) {
    setPreviousStatus(status);
    setFadedStatus(null);
  }
  useEffect(() => {
    if (status !== "Saved on this computer") return;
    const timer = window.setTimeout(() => setFadedStatus(status), 3000);
    return () => window.clearTimeout(timer);
  }, [status]);
  const isSaved = status === "Saved on this computer";
  const sync = useRecordSyncState(savedDocument?.id ?? null, isSaved);
  const reviewRequired = needsReview || sync === "needs_review";
  const statusLine = (
    <span
      role="status"
      aria-label={capture ? "Document save status" : "Document sync status"}
      className="document-status"
    >
      {reviewRequired ? (
        // Saved, but changed on two desktops: that is the state worth saying.
        <>
          <StatusDot tone="attention" size={10} />
          Needs review
        </>
      ) : sync === "synced" ? (
        <>
          <CloudCheck aria-hidden="true" />
          Synced to Drive
        </>
      ) : (
        <>
          {isSaved && <Check aria-hidden="true" />}
          {capture && isSaved ? "Saved" : status}
        </>
      )}
    </span>
  );
  // What happens to the draft: kept by draft recovery if the person leaves,
  // kept only in the editor, or (when recovery failed too) at risk.
  const draftNote = failedTrash
    ? ""
    : draftAtRisk
      ? " This device cannot safely keep the draft. Attached files need workspace recovery. Retry, copy the text, or discard it to close."
      : recovery.active
        ? " Your draft stays on this device if you close."
        : " Your draft is still here.";
  const saveError = failed && failure && (
    <FailureAlert
      {...(capture && { size: "compact" as const })}
      failure={{ ...failure, sentence: `${failure.sentence}${draftNote}` }}
      onRetry={retry}
      actions={
        draftAtRisk ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void writeClipboard(draft.current.body).then((failure) =>
                  setCopyResult(
                    failure
                      ? `Couldn’t copy: ${failure}.`
                      : "Draft text copied.",
                  ),
                );
              }}
            >
              Copy text
            </Button>
            {copyResult && <span role="status">{copyResult}</span>}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                closeRequested.current = false;
                afterSave.current = null;
                void recovery.put(recoveryOwner, null, []).catch(() => {});
                if (!initial && fallbackWorkspace.current)
                  void clearCaptureTextDraft(fallbackWorkspace.current).catch(
                    () => {},
                  );
                draftAtRisk();
              }}
            >
              Discard and close
            </Button>
          </>
        ) : (
          (capture || leaveBlocked) &&
          recovery.active && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const leave = leaveBlocked ?? (() => close.current());
                setLeaveBlocked(null);
                void leaveKeepingDraft(leave);
              }}
            >
              {capture ? "Close and keep draft" : "Leave and keep draft"}
            </Button>
          )
        )
      }
    />
  );
  const connected = groupConnections(links);
  // The header names the Plan the Document belongs to: the one it is the spec of, else an Active
  // one, else an Archived one (the core orders the row's Plans that way).
  const crumbPlan = row?.plans?.[0];
  // A Plan attached to the Document is listed under Linked, not as a mention.
  const isMention = (item: (typeof connected)[number]) =>
    item.kind !== "plan" || item.passages.length > 0;
  // Reference order (T-KQ1 before T-KQ3), not the order the links were recorded in.
  const mentions = connected
    .filter(isMention)
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
  const linkedPlans = row?.plans ?? [];
  const linkedTickets = row?.tickets ?? [];
  // The mentions stay unmounted until first opened: a long Document can have dozens of passages.
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [mentionsSeen, setMentionsSeen] = useState(false);
  const mentionedBy = (kind: string, one: string, many: string) => {
    const count = mentions.filter((item) => item.kind === kind).length;
    return count > 0 ? plural(count, one, many) : "";
  };
  const mentionedLabel = `Mentioned in ${[
    mentionedBy("ticket", "ticket", "tickets"),
    mentionedBy("document", "Document", "Documents"),
    mentionedBy("plan", "Plan", "Plans"),
  ]
    .filter(Boolean)
    .join(" and ")}`;
  const passages = [
    ...new Set(mentions.flatMap((item) => item.passages)),
  ].filter((passage) => !bareLinkLabel(passage));
  const passageView = (passage: string) => (
    <DocumentNavigation.Provider
      key={passage}
      value={onOpenDocument ? (id) => navigate(() => onOpenDocument(id)) : null}
    >
      <PlanNavigation.Provider
        value={onOpenPlan ? (id) => navigate(() => onOpenPlan(id)) : null}
      >
        <div className="document-passage">
          <MarkdownDocument
            revision={workspaceRevision}
            source={passage}
            select={
              onOpenTicket
                ? (reference) => navigate(() => onOpenTicket(reference))
                : undefined
            }
          />
        </div>
      </PlanNavigation.Provider>
    </DocumentNavigation.Provider>
  );
  const connectionRow = (item: (typeof connected)[number]) => (
    <li key={`${item.kind}-${item.id}`}>
      <Button
        variant="ghost"
        onClick={() => {
          if (item.kind === "document")
            navigate(() => onOpenDocument?.(item.id));
          else if (item.kind === "ticket")
            navigate(() => onOpenTicket?.(item.label));
          else if (item.kind === "plan") navigate(() => onOpenPlan?.(item.id));
        }}
      >
        <ConnectedLabel item={item} />
      </Button>
      {item.attached && item.passages.length === 0 && item.kind !== "plan" && (
        <p className="document-direction">
          {item.to ? "Attached Document" : `Attached to ${item.label}`}
        </p>
      )}
    </li>
  );
  const updatedAt = savedDocument?.updated_at ?? initial?.updated_at ?? "";
  const createdAt = savedDocument?.created_at ?? initial?.created_at ?? "";
  const panelLabel =
    panel === "tags"
      ? "Add tags"
      : panel === "link"
        ? "Link a Document"
        : panel === "ticket"
          ? "Create ticket from this"
          : "Details";
  /** Adds or removes a tag; resolves to whether it worked. */
  const changeTag = async (tag: string, present: boolean) => {
    if (!initial) return false;
    setActionError(null);
    try {
      await documents.tag(initial.id, tag, present);
      refreshLinks();
      return true;
    } catch (error) {
      setActionError(
        describeFailure(
          error,
          present ? `add the tag ${tag.trim()}` : `remove the tag ${tag}`,
        ),
      );
      return false;
    }
  };
  const panelContent = initial && panel && (
    <>
      {panel === "details" && (
        <DocumentDetails
          document={initial}
          createdAt={createdAt}
          updatedAt={updatedAt}
          plans={row?.plans ?? []}
          onOpenTicket={(reference) =>
            navigate(() => onOpenTicket?.(reference))
          }
        />
      )}
      {panel === "tags" && (
        <form
          className="document-panel-form"
          onSubmit={(event) => {
            event.preventDefault();
            const tag = newTag;
            if (!tag.trim()) return;
            void changeTag(tag, true).then((added) => {
              if (!added) return;
              setNewTag("");
              setPanel(null);
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor="new-document-tag">Add tag</FieldLabel>
            <Input
              id="new-document-tag"
              autoFocus
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!newTag.trim()}>
            Add tag
          </Button>
        </form>
      )}
      {panel === "link" && (
        <DocumentPicker
          exclude={[initial.id]}
          onPick={(picked) => {
            const link = documentLinkMarkdown(picked.id, picked.heading);
            const next = draft.current.body
              ? `${draft.current.body}\n\n${link}`
              : link;
            draft.current = { ...draft.current, body: next };
            setBody(next);
            setLinkError(null);
            setPanel(null);
          }}
        />
      )}
      {panel === "ticket" && (
        <div className="document-panel-form">
          <Field>
            <FieldLabel htmlFor="ticket-from-document">
              New ticket title
            </FieldLabel>
            <Input
              id="ticket-from-document"
              autoFocus
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
              setCreateError(null);
              void documents
                .createTicket(initial.id, ticketTitle, ticketRequest.current.id)
                .then((ticket) =>
                  navigate(() => onOpenTicket?.(ticket.reference)),
                )
                .catch((error: unknown) =>
                  setCreateError(describeFailure(error, "create the ticket")),
                )
                .finally(() => {
                  creatingTicket.current = false;
                });
            }}
          >
            Create ticket
          </Button>
          {createError && <FailureAlert size="compact" failure={createError} />}
        </div>
      )}
    </>
  );
  const readerFeedback = (
    <>
      {saveError}
      {external && (
        <Alert ref={noticeRef} tabIndex={-1}>
          <AlertDescription>
            Saved content changed while you were editing. Choose “Reload saved
            content” to discard your draft, or “Save my draft” to replace the
            saved content with it.
            {blockedLeaving && " Choose Reload or Save my draft first."}
          </AlertDescription>
          <AlertActions>
            <Button
              variant="outline"
              onClick={() => {
                setDiscarded(draft.current);
                saved.current = external;
                revision.current = externalRevision.current;
                draft.current = external;
                pending.current = null;
                externalRef.current = null;
                setExternal(null);
                setBlockedLeaving(false);
                setTitle(external.title);
                setSummary(external.summary);
                setBody(external.body);
                setSuggestion(null);
                setFailed(false);
                setStatus("Loaded saved content");
                refocusEditor();
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
                setBlockedLeaving(false);
                void save();
                refocusEditor();
              }}
            >
              Save my draft
            </Button>
          </AlertActions>
        </Alert>
      )}
      {discarded && (
        <Alert role="status" size="compact">
          <AlertDescription>Your draft was discarded.</AlertDescription>
          <Button
            variant="outline"
            onClick={() => {
              draft.current = discarded;
              setTitle(discarded.title);
              setSummary(discarded.summary);
              setBody(discarded.body);
              setDiscarded(null);
              refocusEditor();
            }}
          >
            Undo
          </Button>
        </Alert>
      )}
    </>
  );
  return (
    <DocumentSurface
      capture={capture}
      open={presence.dialog.open}
      onExitComplete={presence.dialog.onExitComplete}
      onClose={requestClose}
      // Cancel, the X and Escape leave as every way out does: after a failed
      // save the draft is kept by draft recovery and the dialog closes, or,
      // when recovery can't keep it, the failure offers Discard and close
      // (plans DR-08, set ER-05).
      onDismiss={requestClose}
      footer={
        suggestion ? (
          <Badge variant="linked">
            <Link2 aria-hidden="true" />
            Linked to <Reference>{suggestion}</Reference>
            <IconButton
              type="button"
              label={`Remove connection to ${suggestion}`}
              size="icon-card"
              onClick={() => {
                draft.current = { ...draft.current, suggestion: null };
                setSuggestion(null);
                refocusEditor();
              }}
            >
              <X />
            </IconButton>
          </Badge>
        ) : null
      }
      note={
        <>
          {statusLine}
          {capture && <span ref={setSessionHost} />}
        </>
      }
      error={capture && saveError}
    >
      {initial && (
        <header className="document-bar" data-expanded={expanded || undefined}>
          {reading && expanded && (
            <span className="document-show-list">
              <IconButton
                ref={showListButton}
                label="Show the Documents list"
                onClick={() => {
                  toggled.current = true;
                  reading.onExpandedChange(false);
                }}
              >
                <PanelLeftOpen />
              </IconButton>
            </span>
          )}
          <span className="document-return">
            <Button
              variant="ghost"
              size="sm"
              aria-label={backLabel}
              onClick={requestClose}
            >
              <ArrowLeft aria-hidden="true" />
              {backLabel.replace(/^Back to /, "")}
            </Button>
          </span>
          {crumbPlan && (
            <span className="document-plan-crumb">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open Plan ${crumbPlan.name}`}
                onClick={() => navigate(() => onOpenPlan?.(crumbPlan.id))}
              >
                <Layers aria-hidden="true" />
                {crumbPlan.name}
              </Button>
            </span>
          )}
          <span aria-hidden="true" className="document-crumb-sep">
            /
          </span>
          <span className="document-crumb-title">{heading}</span>
          <div className="document-actions">
            {reading && !expanded && (
              <span className="document-expand">
                <IconButton
                  ref={expandButton}
                  label="Read full width"
                  onClick={() => {
                    toggled.current = true;
                    reading.onExpandedChange(true);
                  }}
                >
                  <Maximize2 />
                </IconButton>
              </span>
            )}
            {reading && expanded && (
              // The slot stays when the Document is not in the list, so the icons never move.
              <div
                className="document-position"
                role="group"
                aria-label="Position in the list"
              >
                <span className="document-position-text">
                  {reading.place
                    ? `${reading.place.index} of ${reading.place.total}`
                    : "–"}
                </span>
                <IconButton
                  ref={previousButton}
                  label="Previous Document"
                  disabled={!reading.previous}
                  onClick={() =>
                    reading.previous &&
                    navigate(() =>
                      reading.onStep(reading.previous!, "previous"),
                    )
                  }
                >
                  <ChevronUp />
                </IconButton>
                <IconButton
                  ref={nextButton}
                  label="Next Document"
                  disabled={!reading.next}
                  onClick={() =>
                    reading.next &&
                    navigate(() => reading.onStep(reading.next!, "next"))
                  }
                >
                  <ChevronDown />
                </IconButton>
              </div>
            )}
            <Button
              ref={editTrigger}
              variant="ghost"
              size="sm"
              aria-keyshortcuts="E"
              disabled={transitioning || writing || trashed}
              onClick={() => setEditing(true)}
            >
              Edit
              <Kbd aria-hidden="true">E</Kbd>
            </Button>
            {onTogglePin && (
              <IconButton
                label={pinned ? "Unpin Document" : "Pin Document"}
                aria-pressed={pinned}
                onClick={onTogglePin}
              >
                <Pin fill={pinned ? "currentColor" : "none"} />
              </IconButton>
            )}
            <Popover
              open={panel !== null}
              onOpenChange={(open) => {
                if (!open) setPanel(null);
              }}
            >
              <PopoverAnchor asChild>
                <span className="document-more">
                  {/* Kept in Trash too, with Restore, so the header never changes shape (DR-10). */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        ref={actionsTrigger}
                        label="Document actions"
                        disabled={transitioning}
                      >
                        <MoreHorizontal />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      sideOffset={4}
                      onCloseAutoFocus={(event) => {
                        // A panel the menu opened keeps focus.
                        if (panel) event.preventDefault();
                      }}
                    >
                      <DropdownMenuItem onSelect={() => setPanel("details")}>
                        <Info aria-hidden="true" />
                        Details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={locked}
                        onSelect={() => setPanel("tags")}
                      >
                        <Tag aria-hidden="true" />
                        Add tags…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={locked}
                        onSelect={() => setPanel("link")}
                      >
                        <Link2 aria-hidden="true" />
                        Link a Document…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={locked}
                        onSelect={() => {
                          // One step creates: the title starts as the Document's heading.
                          if (!ticketTitle.trim()) setTicketTitle(heading);
                          setPanel("ticket");
                        }}
                      >
                        <SquarePen aria-hidden="true" />
                        Create ticket from this
                      </DropdownMenuItem>
                      {onOpenGraph && (
                        <DropdownMenuItem
                          onSelect={() =>
                            navigate(() => onOpenGraph(initial.id))
                          }
                        >
                          <Network aria-hidden="true" />
                          Open in graph
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                        <Clock aria-hidden="true" />
                        History…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={markdownExport.busy}
                        onSelect={() => void markdownExport.run()}
                      >
                        <FileText aria-hidden="true" />
                        Export Markdown with files…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        {...(!trashed && { variant: "destructive" as const })}
                        onSelect={toggleTrash}
                      >
                        {trashed ? "Restore" : "Move to Trash"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </PopoverAnchor>
              <PopoverContent
                align="end"
                variant={panel === "link" ? "list" : "form"}
                aria-label={panelLabel}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  actionsTrigger.current?.focus();
                }}
              >
                {panelContent}
              </PopoverContent>
            </Popover>
          </div>
          {markdownExport.element}
        </header>
      )}
      {initial && historyOpen && (
        <RecordHistory
          kind="document"
          id={initial.id}
          subtitle={heading}
          onClose={() => setHistoryOpen(false)}
          onRestored={refreshStored}
        />
      )}
      <div
        className="document-main"
        ref={setScroller}
        data-rail={(railShown && scroller) || undefined}
      >
        {railShown && scroller && (
          <DocumentRail
            headings={outline}
            current={currentAnchor}
            scroller={scroller}
            folds={{
              folded: folds.folded.size,
              allFolded: folds.allFolded,
              foldAll: () => keepPlace(folds.foldAll),
              unfoldAll: () => keepPlace(folds.unfoldAll),
            }}
            onChoose={(heading) => {
              // A folded section has nothing to scroll to until it is open.
              flushSync(() => folds.reveal(heading.id));
              goTo(heading.id);
            }}
          >
            {(linkedPlans.length > 0 || linkedTickets.length > 0) && (
              <section aria-label="Linked" className="document-rail-linked">
                <h2>Linked</h2>
                <LinkedItems
                  plans={linkedPlans}
                  tickets={linkedTickets}
                  onOpenPlan={(id) => navigate(() => onOpenPlan?.(id))}
                  onOpenTicket={(reference) =>
                    navigate(() => onOpenTicket?.(reference))
                  }
                />
              </section>
            )}
          </DocumentRail>
        )}
        {initial && <NeedsReviewNotice kind="document" id={initial.id} />}
        {trashed && (
          <div className="document-trash-notice">
            <Alert role="status" size="compact">
              <AlertDescription>In Trash</AlertDescription>
              <Button
                variant="outline"
                size="sm"
                disabled={transitioning}
                onClick={toggleTrash}
              >
                Restore
              </Button>
            </Alert>
          </div>
        )}
        {initial &&
          (writing ? (
            // The title edits in place at the heading's size, without a box.
            <div className="document-title">{titleInput}</div>
          ) : (
            <h1 className="document-title">{heading}</h1>
          ))}
        {initial && (
          // Reading metadata stays in place; editing tools float outside the body.
          <>
            <DocumentMeta
              row={row}
              updatedAt={updatedAt}
              minutes={readingMinutes(readSource)}
              storage={(isSaved || reviewRequired) && statusLine}
              tags={row?.tags ?? []}
              tagsLocked={locked}
              onRemoveTag={(tag) => void changeTag(tag, false)}
              onOpenPlan={(id) => navigate(() => onOpenPlan?.(id))}
              onOpenTicket={(reference) =>
                navigate(() => onOpenTicket?.(reference))
              }
            />
            {writing ? (
              // The author's one-line summary edits in the place it is read.
              <div className="document-summary">
                <Input
                  aria-label="Summary"
                  variant="title"
                  placeholder="Add a one-line summary"
                  readOnly={locked}
                  value={summary}
                  onChange={(event) => {
                    draft.current = {
                      ...draft.current,
                      summary: event.target.value,
                    };
                    setSummary(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    // Enter leaves the field for the text, as it would end a line.
                    if (event.key !== "Enter" || event.nativeEvent.isComposing)
                      return;
                    event.preventDefault();
                    refocusEditor();
                  }}
                />
              </div>
            ) : (
              storedSummary(summary) && (
                <p className="document-summary">{storedSummary(summary)}</p>
              )
            )}
            {actionError && (
              <FailureAlert size="compact" failure={actionError} />
            )}
          </>
        )}
        {initial && (writing || saveError || external || discarded) && (
          <FloatingEditBar
            feedback={
              saveError || external || discarded ? readerFeedback : null
            }
            status={
              failed && !external ? (
                <span role="status" aria-label="Document save status">
                  Not saved{" "}
                  <Button variant="link" size="inline" onClick={retry}>
                    Retry
                  </Button>
                </span>
              ) : isSaved ? (
                fadedStatus === status ? null : (
                  <span role="status" aria-label="Document save status">
                    <Check className="size-3" aria-hidden="true" />
                    Saved
                  </span>
                )
              ) : (
                <span role="status" aria-label="Document save status">
                  {status}
                </span>
              )
            }
            controlsRef={setSessionHost}
            {...(writing && { onDone: () => setEditing(false) })}
          />
        )}
        {!capture && suggestion && (
          <p>
            Connected to {suggestion}{" "}
            <Button
              variant="ghost"
              aria-label={`Remove connection to ${suggestion}`}
              onClick={() => {
                draft.current = { ...draft.current, suggestion: null };
                setSuggestion(null);
                refocusEditor();
              }}
            >
              Remove
            </Button>
          </p>
        )}
        {capture && titleInput}
        <div
          className="document-body"
          {...(initial &&
            !writing &&
            chatSource(heading, { kind: "document", id: initial.id }))}
        >
          {!initial || writing ? (
            <LazyMarkdownEditor
              recoveryOwner={recoveryOwner}
              attachmentTicketReference={currentTicket}
              value={head ? body.slice(head.length) : body}
              onChange={(value) => {
                const next = head + value;
                draft.current = { ...draft.current, body: next };
                setBody(next);
              }}
              onPendingChange={(pending) => {
                editorPending.current = pending;
              }}
              label={capture ? "Your thought" : "Document"}
              placeholder={
                capture ? "Write a thought…" : "Write — type / for blocks"
              }
              readOnly={locked || restoringCapture}
              autoFocus={capture}
              chrome={capture ? "compact" : "floating"}
              chromeHost={sessionHost}
              {...(!capture && { onEscape: () => setEditing(false) })}
              focusRequest={focusRequest}
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
                  revision={workspaceRevision}
                  onChange={
                    locked
                      ? undefined
                      : (value) => {
                          const next =
                            body.slice(0, body.length - readSource.length) +
                            value;
                          draft.current = { ...draft.current, body: next };
                          setBody(next);
                        }
                  }
                  source={readSource}
                  headings={outline}
                  folding={initial ? folds : undefined}
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

        {initial && (
          <aside className="document-end" aria-label="Document details">
            {linkError && (
              <FailureAlert
                size="compact"
                failure={linkError}
                onRetry={() => {
                  setLinkError(null);
                  refreshLinks();
                }}
              />
            )}
            {(linkedPlans.length > 0 || linkedTickets.length > 0) && (
              <section aria-label="Linked">
                <h2>Linked</h2>
                <LinkedItems
                  plans={linkedPlans}
                  tickets={linkedTickets}
                  onOpenPlan={(id) => navigate(() => onOpenPlan?.(id))}
                  onOpenTicket={(reference) =>
                    navigate(() => onOpenTicket?.(reference))
                  }
                />
              </section>
            )}
            {mentions.length > 0 && (
              <section aria-label="Mentions">
                <Disclosure
                  label={mentionedLabel}
                  open={mentionsOpen}
                  onOpenChange={(open) => {
                    setMentionsOpen(open);
                    if (open) setMentionsSeen(true);
                  }}
                >
                  {mentionsSeen && (
                    <>
                      {links.some((group) => group.length === 100) && (
                        <p>Showing the first 100 items in each direction.</p>
                      )}
                      <ul>{mentions.map((item) => connectionRow(item))}</ul>
                      {passages.length > 0 && (
                        <div className="document-passage-caption">
                          <span>
                            {passages.length === 1 && mentions.length > 1
                              ? mentions.length === 2
                                ? "Both from"
                                : "All from"
                              : "From"}{" "}
                            “
                          </span>
                          {passages.map((passage) => passageView(passage))}
                          <span aria-hidden="true">”</span>
                        </div>
                      )}
                    </>
                  )}
                </Disclosure>
              </section>
            )}
            {typeof children === "function" ? children({ trashed }) : children}
          </aside>
        )}
      </div>
      {initial &&
        !writing &&
        scroller &&
        !railShown &&
        showsOutline(outline) && (
          <DocumentOutline
            headings={outline}
            current={currentAnchor}
            folds={{
              folded: folds.folded.size,
              allFolded: folds.allFolded,
              foldAll: () => keepPlace(folds.foldAll),
              unfoldAll: () => keepPlace(folds.unfoldAll),
            }}
            onChoose={(heading) => {
              // A folded section has nothing to scroll to until it is open.
              flushSync(() => folds.reveal(heading.id));
              goTo(heading.id);
            }}
          />
        )}
    </DocumentSurface>
  );
}

/** A passage that is only a link says nothing but its target's title: name it instead of quoting it. */
function bareLinkLabel(passage: string) {
  return /^\s*\[([^\]]+)\]\([^)]*\)\s*$/.exec(passage)?.[1] ?? null;
}

type Connection = {
  kind: string;
  id: string;
  label: string;
  trashed: boolean;
  to: boolean;
  from: boolean;
  passages: string[];
  /** A person attached the Document to the ticket; there is no passage to quote. */
  attached: boolean;
  /** A Plan attachment link (the spec or a supporting Document), which has no passage. */
  attachment: boolean;
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
        attached: false,
        attachment: false,
      };
      if (link.explicit) row.attached = true;
      if (kind === "plan" && !link.passage) row.attachment = true;
      if (out) row.to = true;
      else row.from = true;
      if (link.passage && !row.passages.includes(link.passage))
        row.passages.push(link.passage);
      rows.set(key, row);
    }
  });
  return [...rows.values()];
}
/** Looked-up ticket summaries by reference, so reopening a Document does not refetch them. */
const ticketSummaries = new Map<string, { title: string; status: string }>();
/** Tickets show their status and title beside the reference; Plans using this Document read "Spec of …". */
function ConnectedLabel({ item }: { item: Connection }) {
  const [, refresh] = useState(0);
  const [unresolved, setUnresolved] = useState(false);
  const ticket =
    item.kind === "ticket" ? ticketSummaries.get(item.label) : undefined;
  // A ticket whose summary is still on its way shows a skeleton, not a generic icon and a bare reference.
  const loading = item.kind === "ticket" && !ticket && !unresolved;
  useEffect(() => {
    if (item.kind !== "ticket" || ticketSummaries.has(item.label)) return;
    let current = true;
    void client.showTicket(item.label).then(
      (found) => {
        ticketSummaries.set(item.label, {
          title: found.title,
          status: found.status,
        });
        if (current) refresh((n) => n + 1);
      },
      () => {
        if (current) setUnresolved(true);
      },
    );
    return () => {
      current = false;
    };
  }, [item.kind, item.label]);
  const text =
    item.attachment && item.passages.length === 0
      ? item.label
      : ticket?.title
        ? `${item.label} · ${ticket.title}`
        : item.label;
  const shown = item.trashed ? `${text} (Trash)` : text;
  return (
    <>
      {item.kind === "ticket" ? (
        ticket ? (
          <StatusIcon status={ticket.status} decorative />
        ) : loading ? (
          <Skeleton
            aria-hidden="true"
            shape="circle"
            className="size-4 shrink-0"
          />
        ) : (
          <CircleDashed aria-hidden="true" />
        )
      ) : item.kind === "plan" ? (
        <Layers aria-hidden="true" />
      ) : (
        <FileText aria-hidden="true" />
      )}
      <Tooltip content={shown} overflowOnly>
        <span className="connected-label">{shown}</span>
      </Tooltip>
      {loading && <Skeleton aria-hidden="true" className="h-3 w-24 shrink-0" />}
    </>
  );
}
