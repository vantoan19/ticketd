import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CloudCheck,
  ArrowLeft,
  Check,
  FileText,
  Layers,
  CircleDashed,
  Link2,
  MoreHorizontal,
  Network,
  Pin,
  SquarePen,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Tooltip } from "@/components/ui/tooltip";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { chatSource } from "@/features/chats/quotes";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { useMarkdownExport } from "@/features/attachments/use-markdown-export";
import { Kbd } from "@/components/ui/kbd";
import { FloatingEditBar } from "@/features/markdown/FloatingEditBar";
import { Time } from "@/components/ui/time";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { documentLinkMarkdown } from "./document-link";
import { documents, type Document } from "./api";
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
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import { useRecordSyncState } from "@/features/sync/record-sync";

/**
 * A Document reads in the workspace; a new thought is captured in the one
 * dialog (DialogShell md). Its footer holds the save state in the note slot
 * and Done; a failed save shows above the footer and never traps the dialog.
 */
function DocumentSurface({
  capture,
  onClose,
  onDismiss,
  blockedReason,
  note,
  error,
  children,
}: {
  capture: boolean;
  /** Done: save, then close. */
  onClose: () => void;
  /** Cancel, the X and Escape: close (after a failed save, at once). */
  onDismiss: () => void;
  blockedReason: string | null;
  note: ReactNode;
  error: ReactNode;
  children: ReactNode;
}) {
  if (!capture)
    return <article className="document-workspace">{children}</article>;
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      title="Capture a thought"
      primaryLabel="Done"
      blockedReason={blockedReason}
      footerNote={note}
      error={error}
      onSubmit={onClose}
    >
      {children}
    </DialogShell>
  );
}
function DocumentDate({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (
    value
  ) : (
    <Tooltip
      content={date.toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      })}
    >
      <time dateTime={value} tabIndex={0}>
        {date.toDateString() === new Date().toDateString()
          ? `today at ${date.toLocaleTimeString(undefined, { timeStyle: "short" })}`
          : date.toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
      </time>
    </Tooltip>
  );
}
type Snapshot = { title: string; body: string; suggestion: string | null };
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
const snapshotSchema = z.object({
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
});
const pendingSchema = z.object({
  id: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  titleChanged: z.boolean(),
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
  closeRequest = 0,
  backLabel = "Back to work",
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
  /** Bumped by the host (sidebar "Documents") to ask the reader to save and return to the list. */
  closeRequest?: number;
  /** Label of the reader's footer button; the Documents list says where it returns to. */
  backLabel?: string;
  children?: ReactNode | ((state: { trashed: boolean }) => ReactNode);
}) {
  const { conflicts } = useConflicts();
  const needsReview = conflicts.some(
    (item) => item.kind === "document" && item.id === initial?.id,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  // The floating bar's controls slot, where the editor puts its formatting.
  const [sessionHost, setSessionHost] = useState<HTMLSpanElement | null>(null);
  const recovery = useDraftRecovery();
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ticketTitle, setTicketTitle] = useState("");
  const [creatingFromDocument, setCreatingFromDocument] = useState(false);
  const [links, setLinks] = useState<
    Awaited<ReturnType<typeof documents.links>>
  >([[], []]);
  const [linkError, setLinkError] = useState<FailureDescription | null>(null);
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
  const draft = useRef<Snapshot>({ title, body, suggestion });
  const saved = useRef<Snapshot>(
    recovered?.saved ?? { title, body, suggestion: null },
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
  const persistRecovery = () => {
    const dirty =
      storedTitle(draft.current.title) !== saved.current.title ||
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
  useEffect(() => {
    void persistRecovery().catch(() => {});
  });
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
      );
      window.clearTimeout(slow);
      id.current = result.id;
      revision.current = result.updated_at;
      lastVersion.current = `${result.updated_at}|${result.trashed}`;
      setSavedDocument(result);
      saved.current = {
        ...request.snapshot,
        title: storedTitle(request.snapshot.title),
      };
      pending.current = null;
      await persistRecovery();
      saving.current = false;
      setStatus("Saved on this computer");
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
      setBlockedLeaving(false);
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
      setStatus("Not saved — changed elsewhere");
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
      setDraftAtRisk(() => action);
      return;
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
      className={capture ? undefined : "document-title-input"}
      placeholder={capture ? "e.g. Retry policy for uploads" : "Title"}
      readOnly={locked}
      value={title || (head ? heading : "")}
      onChange={(event) => {
        draft.current = { ...draft.current, title: event.target.value };
        setTitle(event.target.value);
      }}
    />
  );
  const titleField = (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="document-title">
          Title <small>Optional</small>
        </FieldLabel>
        {titleInput}
      </Field>
    </FieldGroup>
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
          {capture && isSaved ? "Saved to Documents as you type" : status}
        </>
      )}
    </span>
  );
  // What happens to the draft: kept by draft recovery if the person leaves,
  // kept only in the editor, or (when recovery failed too) at risk.
  const draftNote = failedTrash
    ? ""
    : draftAtRisk
      ? " This device can't keep the draft either. Retry, or discard it to close."
      : recovery.active
        ? " Your draft stays on this device if you close."
        : " Your draft is still here.";
  const saveError = failed && failure && (
    <FailureAlert
      {...(capture && { size: "compact" as const })}
      failure={{ ...failure, sentence: `${failure.sentence}${draftNote}` }}
      {...((capture || !writing) && { onRetry: retry })}
      actions={
        draftAtRisk ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              closeRequested.current = false;
              afterSave.current = null;
              void recovery.put(recoveryOwner, null, []).catch(() => {});
              draftAtRisk();
            }}
          >
            Discard and close
          </Button>
        ) : (
          leaveBlocked &&
          recovery.active && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const leave = leaveBlocked;
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
  // A Plan link with no passage is a Plan attachment: the designated spec, or (attached) a supporting
  // Document. The Plan can also be mentioned in the body, so the two are tracked separately.
  const planSpec = connected.find(
    (item) => item.kind === "plan" && item.attachment && !item.attached,
  );
  const planSupport = planSpec
    ? undefined
    : connected.find(
        (item) => item.kind === "plan" && item.attachment && item.attached,
      );
  // Plans this Document is the spec of (or supports) have their own section; a Plan that is only
  // attached is not a mention, and every other connection is a mention, listed once.
  const isMention = (item: (typeof connected)[number]) =>
    !item.attachment || item.passages.length > 0;
  // Reference order (T-KQ1 before T-KQ3), not the order the links were recorded in.
  const mentions = connected
    .filter(isMention)
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
  const attachments = connected.filter((item) => item.attachment);
  const attachmentLabel = planSpec ? "Spec of" : "Supporting Document of";
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
  return (
    <DocumentSurface
      capture={capture}
      onClose={requestClose}
      // Cancel, the X and Escape leave as every way out does: after a failed
      // save the draft is kept by draft recovery and the dialog closes, or,
      // when recovery can't keep it, the failure offers Discard and close
      // (plans DR-08, set ER-05).
      onDismiss={requestClose}
      blockedReason={body.trim() ? null : "Write a thought to finish."}
      note={body.trim() && !failed ? statusLine : null}
      error={capture && saveError}
    >
      {initial && (
        <header className="document-bar">
          <Button
            variant="ghost"
            size="sm"
            className="document-crumb"
            aria-label={backLabel}
            onClick={requestClose}
          >
            <ArrowLeft aria-hidden="true" />
            {backLabel.replace(/^Back to /, "")}
          </Button>
          <span aria-hidden="true" className="document-crumb-sep">
            /
          </span>
          <span className="document-crumb-title">{heading}</span>
          <div className="document-actions">
            {!writing && (
              <Button
                ref={editTrigger}
                variant="ghost"
                size="sm"
                aria-keyshortcuts="E"
                disabled={transitioning}
                onClick={() => setEditing(true)}
              >
                Edit
                <Kbd aria-hidden="true">E</Kbd>
              </Button>
            )}
            {onTogglePin && (
              <IconButton
                label={pinned ? "Unpin Document" : "Pin Document"}
                aria-pressed={pinned}
                onClick={onTogglePin}
              >
                <Pin fill={pinned ? "currentColor" : "none"} />
              </IconButton>
            )}
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
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                  History…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={markdownExport.busy}
                  onSelect={() => void markdownExport.run()}
                >
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
      <div className="document-main">
        {initial && <NeedsReviewNotice kind="document" id={initial.id} />}
        {trashed && (
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
          <div className="document-state-row">
            <p className="document-subtitle">
              Updated{" "}
              {Number.isNaN(Date.parse(updatedAt)) ? (
                updatedAt
              ) : (
                <Time value={updatedAt} />
              )}
              {planSpec && ` · spec of the Plan ${planSpec.label}`}
              {planSupport &&
                ` · supporting Document of the Plan ${planSupport.label}`}
            </p>
            {(isSaved || reviewRequired) && statusLine}
          </div>
        )}
        {initial && writing && (
          <FloatingEditBar
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
            onDone={() => setEditing(false)}
          />
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
                refocusEditor();
              }}
            >
              Remove
            </Button>
          </p>
        )}
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
                setBody(discarded.body);
                setDiscarded(null);
                refocusEditor();
              }}
            >
              Undo
            </Button>
          </Alert>
        )}
        {initial && saveError}
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
              label={capture ? "Your thought" : "Document"}
              placeholder={
                capture ? "Write a thought…" : "Write — type / for blocks"
              }
              readOnly={locked}
              autoFocus={capture}
              {...(!capture && {
                chrome: "floating" as const,
                chromeHost: sessionHost,
                onEscape: () => setEditing(false),
              })}
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
                          const shown = withoutDerivedHeading(
                            body,
                            title,
                            savedDocument?.heading,
                          );
                          const next =
                            body.slice(0, body.length - shown.length) + value;
                          draft.current = { ...draft.current, body: next };
                          setBody(next);
                        }
                  }
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
      </div>
      {initial && (
        <aside className="document-rail" aria-label="Document details">
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
          {mentions.length > 0 && (
            <section aria-label="Mentions">
              <h2>Mentions</h2>
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
            </section>
          )}
          {attachments.length > 0 && (
            <section aria-label={attachmentLabel}>
              <h2>{attachmentLabel}</h2>
              <ul>{attachments.map((item) => connectionRow(item))}</ul>
            </section>
          )}
          {typeof children === "function" ? children({ trashed }) : children}
          <section aria-label="Document properties">
            <dl>
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
                      {initial.origin_ticket} · Update details
                    </Button>
                  </dd>
                </>
              )}
              <dt>Visibility</dt>
              <dd>
                {initial.origin_brief
                  ? initial.kept
                    ? "Kept in Documents"
                    : "Hidden with its update"
                  : "Shown in Documents"}
              </dd>
            </dl>
            <p className="document-timestamps">
              {updatedAt === createdAt ? (
                <>
                  Created and updated <DocumentDate value={updatedAt} />
                </>
              ) : (
                <>
                  Updated <DocumentDate value={updatedAt} /> · created{" "}
                  <DocumentDate value={createdAt} />
                </>
              )}
            </p>
          </section>
          <div className="document-rail-actions">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button disabled={locked} variant="ghost">
                  <Link2 aria-hidden="true" />
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
                    setLinkError(null);
                    setPickerOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            {!creatingFromDocument && (
              <Button
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  // One click creates: the title starts as the Document's heading.
                  if (!ticketTitle.trim()) setTicketTitle(heading);
                  setCreatingFromDocument(true);
                }}
              >
                <SquarePen aria-hidden="true" />
                Create ticket from this
              </Button>
            )}
            {onOpenGraph && (
              <Button
                variant="ghost"
                onClick={() => navigate(() => onOpenGraph(initial.id))}
              >
                <Network aria-hidden="true" />
                Open graph
              </Button>
            )}
          </div>
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
                setCreateError(null);
                void documents
                  .createTicket(
                    initial.id,
                    ticketTitle,
                    ticketRequest.current.id,
                  )
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
            {createError && (
              <FailureAlert size="compact" failure={createError} />
            )}
          </div>
        </aside>
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
            className="size-4 shrink-0 rounded-full"
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
