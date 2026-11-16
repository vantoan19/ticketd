import { Check, LoaderCircle, Circle } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert, AlertActions, AlertDescription } from "@/components/ui/alert";
import "./description.css";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { chatSource } from "@/features/chats/quotes";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { FieldError } from "@/components/ui/field";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { FloatingEditBar } from "@/features/markdown/FloatingEditBar";
import { client, type Ticket } from "@/lib/api/client";
import { charSpanToUtf16, mentionStillAt, withoutBom } from "./mention-passage";
import { revealInDetail } from "./detail-scroll";
import { z } from "zod";
import { useDraftRecovery } from "@/lib/draft-recovery-context";

/**
 * A backlink's passage, and the span of its mention as the core reports it: chars
 * into the description without a leading byte order mark.
 */
export type Mention = {
  passage: string;
  mentioned: string;
  start: number;
  end: number;
  key: number;
};
type Content = Pick<Ticket, "title" | "body">;

/**
 * An unsaved title or description draft, with the saved text it was written
 * against, so a reload can tell whether the stored ticket changed meanwhile.
 */
type StoredDraft = Content & { baseTitle: string; baseBody: string };
const storedDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  baseTitle: z.string(),
  baseBody: z.string(),
});
const draftKey = (id: string) => `ticketd:ticket-draft:${id}`;

function storeDraft(id: string, draft: Content, saved: Content) {
  try {
    if (draft.title === saved.title && draft.body === saved.body)
      localStorage.removeItem(draftKey(id));
    else
      localStorage.setItem(
        draftKey(id),
        JSON.stringify({
          ...draft,
          baseTitle: saved.title,
          baseBody: saved.body,
        } satisfies StoredDraft),
      );
  } catch {
    /* A draft that cannot be kept on this device is still kept in the editor. */
  }
}

/** The editor's starting text: the ticket, plus any draft left behind on this device. */
function restore(
  ticket: Ticket,
  retained?: StoredDraft | null,
  coreActive = false,
): { draft: Content; saved: Content } {
  const current = { title: ticket.title, body: ticket.body };
  try {
    const raw = coreActive ? null : localStorage.getItem(draftKey(ticket.id));
    const value: unknown = retained ?? (raw ? JSON.parse(raw) : null);
    if (typeof value === "object" && value !== null) {
      const stored = value as Partial<StoredDraft>;
      const titleDirty =
        typeof stored.title === "string" &&
        typeof stored.baseTitle === "string" &&
        stored.title !== stored.baseTitle;
      const bodyDirty =
        typeof stored.body === "string" &&
        typeof stored.baseBody === "string" &&
        stored.body !== stored.baseBody;
      return {
        draft: {
          title: titleDirty ? (stored.title ?? current.title) : current.title,
          body: bodyDirty ? (stored.body ?? current.body) : current.body,
        },
        // Judge the draft against the text it was written over.
        saved: {
          title: titleDirty
            ? (stored.baseTitle ?? current.title)
            : current.title,
          body: bodyDirty ? (stored.baseBody ?? current.body) : current.body,
        },
      };
    }
  } catch {
    /* Start from the ticket. */
  }
  return { draft: current, saved: current };
}
export function TicketEditor({
  ticket,
  onSaved,
  stateLine,
  children,
  select,
  revision,
  mention = null,
}: {
  ticket: Ticket;
  onSaved: (ticket: Ticket) => void;
  /**
   * The ticket's stable state line. Editor controls float outside the prose.
   */
  stateLine?: ReactNode;
  /** Under the state row: the folded property strip. */
  children?: ReactNode;
  select?: (reference: string) => void;
  revision?: number;
  /** A description passage the person navigated here to read; null once they move on. */
  mention?: Mention | null;
}) {
  const recovery = useDraftRecovery();
  const recoveryOwner = `ticket:${ticket.id}`;
  const blockedReason = editingBlockedReason(useWorkspaceState());
  const [restored] = useState(() =>
    restore(
      ticket,
      recovery.read(recoveryOwner, storedDraftSchema),
      recovery.active,
    ),
  );
  const [draft, setDraft] = useState<Content>(restored.draft);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const fitTitle = () => {
      if (!title.clientWidth) return;
      title.style.height = "auto";
      title.style.height = `${title.scrollHeight}px`;
    };
    fitTitle();
    void document.fonts?.ready.then(fitTitle);
    document.fonts?.addEventListener("loadingdone", fitTitle);
    if (typeof ResizeObserver === "undefined")
      return () => document.fonts?.removeEventListener("loadingdone", fitTitle);
    let width = title.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      fitTitle();
    });
    observer.observe(title);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", fitTitle);
    };
  }, [draft.title]);
  const [saved, setSaved] = useState<Content>(restored.saved);
  const [confirmSaved, setConfirmSaved] = useState(false);
  // After "Use saved text", what the save state says instead of "saved".
  const [adopted, setAdopted] = useState<string | null>(null);
  // Keep the unsaved text on this device, and write it once more as the page goes away.
  const ticketId = ticket.id;
  const latest = useRef({ draft, saved });
  useEffect(() => {
    latest.current = { draft, saved };
    if (recovery.active) {
      const dirty = draft.title !== saved.title || draft.body !== saved.body;
      void recovery
        .put(
          recoveryOwner,
          dirty
            ? { ...draft, baseTitle: saved.title, baseBody: saved.body }
            : null,
          dirty ? [draft.body] : [],
        )
        .catch(() => {});
    } else storeDraft(ticketId, draft, saved);
  }, [draft, saved, ticketId, recovery, recoveryOwner]);
  useEffect(() => {
    const flush = () => {
      if (!recovery.active)
        storeDraft(ticketId, latest.current.draft, latest.current.saved);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [ticketId, recovery]);
  // "idle" until something is saved, so an untouched ticket doesn't say "Saved".
  const [state, setState] = useState<"idle" | "saved" | "pending" | "failed">(
    "idle",
  );
  const [error, setError] = useState<FailureDescription | null>(null);
  const [retry, setRetry] = useState(0);
  // "Saved" says so for 3s, then the state line's time is enough (P6).
  useEffect(() => {
    if (state !== "saved") return;
    const timer = window.setTimeout(() => setState("idle"), 3000);
    return () => window.clearTimeout(timer);
  }, [state]);
  // The floating bar hosts the editor's existing formatting controls.
  const [sessionHost, setSessionHost] = useState<HTMLSpanElement | null>(null);
  // "Keep my draft" saves at once instead of waiting out the typing delay.
  const immediate = useRef(false);
  const [bodyFocus, setBodyFocus] = useState(0);
  const [bodyCaret, setBodyCaret] = useState<string | undefined>();
  const [bodyMode, setBodyMode] = useState<"unopened" | "editing" | "reading">(
    "unopened",
  );
  const editingBody = bodyMode === "editing";
  // The rail's Documents offer "Edit description" for a Document the description mentions.
  const reference = ticket.reference;
  useEffect(() => {
    const edit = (event: Event) => {
      const detail = (
        event as CustomEvent<{ reference: string; documentId?: string }>
      ).detail;
      if (detail.reference === reference && !blockedReason) {
        setBodyCaret(detail.documentId);
        setBodyMode("editing");
        setBodyFocus((count) => count + 1);
      }
    };
    window.addEventListener("ticketd:edit-description", edit);
    return () => window.removeEventListener("ticketd:edit-description", edit);
  }, [reference, blockedReason]);
  const editButton = useRef<HTMLElement>(null);
  // E edits the description of the ticket in view, unless typing or another dialog has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "e" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const button = editButton.current;
      // A hidden page, or one the dependency graph covers, is not in view.
      if (!button || button.closest("[hidden], [data-graph]")) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]",
        )
      )
        return;
      event.preventDefault();
      if (!blockedReason) setBodyMode("editing");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blockedReason]);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  // Which field the last save carried, so the status line names it.
  const [savedField, setSavedField] = useState("Changes");
  const bodyRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  // A mention is revealed once. It is dropped when the person starts editing, when
  // the saved text changes under it, or when the next navigation clears it, so
  // none of those can bring the highlight back.
  const [handledMention, setHandledMention] = useState<number | null>(null);
  const [shown, setShown] = useState<{ mention: Mention; body: string } | null>(
    null,
  );
  if (mention && mention.key !== handledMention) {
    setHandledMention(mention.key);
    // Judge the mention against the saved body the core computed it from.
    setShown({ mention, body: ticket.body });
    // The rendered description is hidden while editing; a mention returns to it.
    if (bodyMode === "editing") setBodyMode("reading");
  } else if (shown && (!mention || editingBody || shown.body !== ticket.body)) {
    setShown(null);
  }
  // The renderer sees the body without its byte order mark, and the core counts
  // chars; the mark needs UTF-16 offsets into that same text.
  const rendered = withoutBom(draft.body);
  const titleConflict =
    draft.title !== saved.title && ticket.title !== saved.title;
  const bodyConflict = draft.body !== saved.body && ticket.body !== saved.body;
  const span = shown
    ? charSpanToUtf16(rendered, {
        start: shown.mention.start,
        end: shown.mention.end,
      })
    : null;
  const mark =
    shown && span && mentionStillAt(rendered, shown.mention.passage, span)
      ? { ...span, describedBy: `mention-note-${ticket.id}` }
      : undefined;
  // Scroll to the marked passage and focus it, once per mention. React renders the
  // mark; this only reads the DOM and writes the status text it points to. When no
  // block carries the mark, say so and land on the description instead.
  useEffect(() => {
    if (!shown) {
      if (noteRef.current) {
        noteRef.current.textContent = "";
        noteRef.current.className = "sr-only";
      }
      return;
    }
    const block =
      documentRef.current?.querySelector<HTMLElement>(
        "[data-mention-target]",
      ) ?? null;
    const target = block ?? bodyRef.current;
    const note = noteRef.current;
    if (note) {
      note.textContent = block
        ? `Mentions ${shown.mention.mentioned}`
        : `Couldn't find the mention of ${shown.mention.mentioned} in the rendered description.`;
      note.className = block ? "sr-only" : "mention-missing";
    }
    if (target) {
      revealInDetail(target);
      target.focus({ preventScroll: true });
    }
  }, [shown]);
  const dirty = draft.title !== saved.title || draft.body !== saved.body;
  const titleDirty = draft.title !== saved.title;
  // A ticket always has a title: an empty one is never sent (the core would
  // refuse it), the last saved title stays, and the field says why.
  const titleInvalid = titleDirty && draft.title.trim() === "";
  const unsent = (titleDirty && !titleInvalid) || draft.body !== saved.body;
  const bodyDirty = draft.body !== saved.body;
  const externalChange =
    (titleDirty && ticket.title !== saved.title) ||
    (bodyDirty && ticket.body !== saved.body);
  // Refresh untouched fields independently while retaining a draft in the other field.
  if (
    !saving &&
    ((!titleDirty && ticket.title !== saved.title) ||
      (!bodyDirty && ticket.body !== saved.body))
  ) {
    const content = {
      title: titleDirty ? saved.title : ticket.title,
      body: bodyDirty ? saved.body : ticket.body,
    };
    setSaved(content);
    setDraft({
      title: titleDirty ? draft.title : content.title,
      body: bodyDirty ? draft.body : content.body,
    });
  }

  useEffect(() => {
    if (
      blockedReason ||
      !unsent ||
      externalChange ||
      inFlight.current ||
      state === "failed"
    )
      return;
    const delay = immediate.current ? 0 : 500;
    const timer = window.setTimeout(() => {
      immediate.current = false;
      inFlight.current = true;
      setSaving(true);
      setState("pending");
      const patch: { title?: string; body?: string } = {};
      if (draft.title !== saved.title && !titleInvalid)
        patch.title = draft.title;
      if (draft.body !== saved.body) patch.body = draft.body;
      setSavedField(
        patch.title !== undefined && patch.body !== undefined
          ? "Title and description"
          : patch.title !== undefined
            ? "Title"
            : "Description",
      );
      // The core refuses the change if the stored text is no longer what this editor
      // last loaded or saved, so an agent's edit is never silently overwritten.
      const guarded = {
        ...patch,
        ...(patch.title !== undefined && { expected_title: saved.title }),
        ...(patch.body !== undefined && { expected_body: saved.body }),
      };
      void recovery
        .flush()
        .then(() => client.changeTicket(ticket.reference, guarded))
        .then((result) => {
          setSaved({ title: result.title, body: result.body });
          setDraft((current) => ({
            title:
              patch.title !== undefined && current.title === draft.title
                ? result.title
                : current.title,
            body: current.body === draft.body ? result.body : current.body,
          }));
          onSaved(result);
          setError(null);
          setState("saved");
        })
        .catch(async (reason: unknown) => {
          if (toFailure(reason).kind === "conflict") {
            try {
              const latest = await client.showTicket(ticket.reference);
              // The parent adopts the stored ticket, so the notice below compares
              // the draft with it. A field whose draft already equals the stored
              // text has nothing to resolve.
              setSaved((current) => ({
                title:
                  draft.title === latest.title ? latest.title : current.title,
                body: draft.body === latest.body ? latest.body : current.body,
              }));
              onSaved(latest);
              setState("pending");
              return;
            } catch {
              /* Fall through to the ordinary failure. */
            }
          }
          setError(
            describeFailure(
              reason,
              patch.title !== undefined && patch.body !== undefined
                ? "save the title and description"
                : patch.title !== undefined
                  ? "save the title"
                  : "save the description",
            ),
          );
          setState("failed");
        })
        .finally(() => {
          inFlight.current = false;
          setSaving(false);
        });
    }, delay);
    return () => window.clearTimeout(timer);
    // `saving` re-arms the save a conflict choice made while another was still in flight.
  }, [
    blockedReason,
    draft,
    saved,
    unsent,
    titleInvalid,
    externalChange,
    ticket.reference,
    onSaved,
    state,
    retry,
    saving,
    recovery,
  ]);

  /**
   * "Use saved text": only the field in conflict takes the saved text; a
   * draft in the other field stays and keeps saving. Nothing was saved, so
   * the save state says which saved text is now in use.
   */
  function adoptSaved() {
    const next = {
      title: titleConflict ? ticket.title : draft.title,
      body: bodyConflict ? ticket.body : draft.body,
    };
    const base = {
      title: titleConflict ? ticket.title : saved.title,
      body: bodyConflict ? ticket.body : saved.body,
    };
    setDraft(next);
    setSaved(base);
    setConfirmSaved(false);
    const stillDirty = next.title !== base.title || next.body !== base.body;
    setAdopted(
      titleConflict && bodyConflict
        ? "Using the saved title and description"
        : titleConflict
          ? "Using the saved title"
          : "Using the saved description",
    );
    setState(stillDirty ? "pending" : "idle");
    focusEditor();
  }
  /** After a conflict choice the notice goes away; the caret returns to the text in conflict. */
  function focusEditor() {
    if (bodyConflict) {
      setBodyMode("editing");
      setBodyFocus((count) => count + 1);
    } else window.requestAnimationFrame(() => titleRef.current?.focus());
  }
  const conflict = externalChange && dirty;
  const draftHasText =
    (titleConflict && draft.title.trim() !== "") ||
    (bodyConflict && draft.body.trim() !== "");
  // Title and description edits record no author, so only a source ticket can name who changed it.
  const changedBy = ticket.source?.provider_name
    ? ` by ${ticket.source.provider_name}`
    : "";
  const notice = conflict && (
    <Alert
      tone="attention"
      size="compact"
      role="status"
      className="editor-conflict"
    >
      <AlertDescription>
        {titleConflict && bodyConflict
          ? "The saved title and description"
          : titleConflict
            ? "The saved title"
            : "The saved description"}{" "}
        changed elsewhere{changedBy} while you were editing.
        {titleConflict && (
          <>
            {" "}
            Saved: <strong>{ticket.title}</strong>
          </>
        )}
      </AlertDescription>
      <AlertActions>
        {confirmSaved ? (
          <>
            <span className="editor-conflict-question">
              Discard your draft?
            </span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setConfirmSaved(false);
                focusEditor();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              type="button"
              onClick={() => adoptSaved()}
              autoFocus
            >
              Discard draft
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                immediate.current = true;
                setSaved({ title: ticket.title, body: ticket.body });
                setState("pending");
                focusEditor();
              }}
            >
              Keep my draft
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() =>
                draftHasText ? setConfirmSaved(true) : adoptSaved()
              }
            >
              Use saved text
            </Button>
          </>
        )}
      </AlertActions>
    </Alert>
  );
  function edit(next: Content) {
    setDraft(next);
    setAdopted(null);
    setState("pending");
  }
  function finishEditing() {
    const previousFocus = document.activeElement;
    setBodyMode("reading");
    window.requestAnimationFrame(() => {
      // Closing hides the editor and can leave focus on the body. Respect any
      // newer focus choice, and keep the pane at its current reading position.
      if (
        document.activeElement === document.body ||
        document.activeElement === previousFocus
      )
        editButton.current?.focus({ preventScroll: true });
    });
  }
  const saveState = saving
    ? "Saving…"
    : conflict
      ? "Unsaved — choose a version"
      : unsent && state !== "failed"
        ? "Pending save"
        : state === "failed"
          ? `${savedField} not saved`
          : state === "saved"
            ? `${savedField} saved`
            : (adopted ?? "");
  return (
    <div className="ticket-editor">
      <label className="editor-title">
        <span className="sr-only">Title</span>
        <textarea
          ref={titleRef}
          aria-label="Title"
          disabled={Boolean(blockedReason)}
          rows={1}
          value={draft.title}
          aria-invalid={titleInvalid || undefined}
          aria-describedby={
            titleInvalid ? `title-error-${ticket.id}` : undefined
          }
          onChange={(event) => edit({ ...draft, title: event.target.value })}
        />
      </label>
      {titleInvalid && (
        <div className="editor-title-error">
          <FieldError id={`title-error-${ticket.id}`}>
            A ticket needs a title.
          </FieldError>
        </div>
      )}
      {titleConflict && !bodyConflict && notice}
      {children}
      <div className="ticket-state-row" data-floating={!stateLine || undefined}>
        <span className="ticket-state-text">{stateLine}</span>
        {!editingBody && state !== "failed" && (
          <span role="status" className="editor-save-state">
            {saveState}
          </span>
        )}
      </div>
      {(editingBody || state === "failed") && (
        <FloatingEditBar
          controlsRef={setSessionHost}
          onDone={finishEditing}
          status={
            <span role="status" data-save={state}>
              {state === "failed" ? (
                <Circle
                  className="size-2 fill-current text-status-blocked"
                  aria-hidden="true"
                />
              ) : !conflict && (saving || unsent) ? (
                <LoaderCircle
                  className="size-3 animate-spin"
                  aria-hidden="true"
                />
              ) : state === "saved" ? (
                <Check className="size-3" aria-hidden="true" />
              ) : null}
              {state === "failed"
                ? "Not saved"
                : conflict
                  ? "Choose a version"
                  : saving || unsent
                    ? "Saving…"
                    : state === "saved"
                      ? "Saved"
                      : ""}
              {state === "failed" && (
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => {
                    setState("pending");
                    setRetry((value) => value + 1);
                  }}
                >
                  Retry
                </Button>
              )}
            </span>
          }
        />
      )}
      <div
        className="editor-body"
        ref={bodyRef}
        tabIndex={-1}
        role="group"
        aria-labelledby={`body-${ticket.id}`}
      >
        {/* Always present, so a screen reader announces text written into it. */}
        <p
          ref={noteRef}
          id={`mention-note-${ticket.id}`}
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        />
        {bodyConflict && notice}
        <span id={`body-${ticket.id}`} className="sr-only">
          Description
        </span>
        {bodyConflict && (
          <div className="conflict-block">
            <p className="conflict-block-label">Saved text</p>
            <div className="markdown-preview description-document">
              {ticket.body.trim() ? (
                <MarkdownDocument
                  source={withoutBom(ticket.body)}
                  select={select}
                  revision={revision}
                />
              ) : (
                <EmptyState size="hint" title="No description." />
              )}
            </div>
          </div>
        )}
        {bodyConflict && (
          <p className="conflict-block-label conflict-block">
            Your unsaved draft
          </p>
        )}
        {bodyMode !== "unopened" && (
          <div hidden={!editingBody}>
            <LazyMarkdownEditor
              value={draft.body}
              readOnly={Boolean(blockedReason)}
              recoveryOwner={recoveryOwner}
              attachmentTicketReference={ticket.reference}
              onChange={(body) => edit({ ...draft, body })}
              label="Description"
              placeholder="Add a description — type / for blocks"
              chrome="floating"
              chromeHost={editingBody ? sessionHost : null}
              onEscape={finishEditing}
              autoFocus={editingBody}
              focusRequest={bodyFocus}
              {...(bodyCaret ? { focusLink: bodyCaret } : {})}
            />
          </div>
        )}
        {!editingBody &&
          (draft.body ? (
            <Tooltip content={blockedReason ?? "Edit description"} shortcut="E">
              <div
                className="description-reading"
                ref={(element) => {
                  editButton.current = element;
                }}
                role="group"
                tabIndex={0}
                aria-label="Read description"
                aria-keyshortcuts="E"
                aria-disabled={Boolean(blockedReason)}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    if (!blockedReason) setBodyMode("editing");
                  }
                }}
                onClick={(event) => {
                  if (
                    blockedReason ||
                    !event.currentTarget.contains(event.target as Node) ||
                    window.getSelection()?.toString()
                  )
                    return;
                  if (
                    event.target instanceof Element &&
                    event.target.closest("a, button, input")
                  )
                    return;
                  setBodyMode("editing");
                }}
              >
                <div
                  ref={documentRef}
                  className={`markdown-preview description-document${bodyConflict ? " conflict-draft" : ""}`}
                  {...chatSource(`${ticket.reference} · Description`, {
                    kind: "ticket",
                    id: ticket.id,
                  })}
                >
                  <MarkdownDocument
                    source={rendered}
                    {...(!blockedReason && {
                      onChange: (body: string) =>
                        edit({
                          ...draft,
                          body: draft.body.startsWith("\uFEFF")
                            ? `\uFEFF${body}`
                            : body,
                        }),
                    })}
                    select={select}
                    revision={revision}
                    mention={mark}
                  />
                </div>
              </div>
            </Tooltip>
          ) : (
            // One quiet line that becomes the editor in place (detA DS-06).
            <Tooltip content={blockedReason ?? "Edit description (E)"}>
              <span
                className="description-edit-control"
                tabIndex={blockedReason ? 0 : undefined}
                aria-disabled={blockedReason ? true : undefined}
              >
                <button
                  disabled={Boolean(blockedReason)}
                  type="button"
                  ref={(element) => {
                    editButton.current = element;
                  }}
                  className="description-add"
                  aria-keyshortcuts="E"
                  onClick={() => setBodyMode("editing")}
                >
                  Add a description…
                </button>
              </span>
            </Tooltip>
          ))}
      </div>
      {state === "failed" && error && (
        <div className="ticket-save-error">
          <FailureAlert size="compact" failure={error} />
        </div>
      )}
    </div>
  );
}
