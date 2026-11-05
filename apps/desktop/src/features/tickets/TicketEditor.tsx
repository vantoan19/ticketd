import "./description.css";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { client, type Ticket } from "@/lib/api/client";
import { charSpanToUtf16, mentionStillAt, withoutBom } from "./mention-passage";
import { revealInDetail } from "./detail-scroll";

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
function restore(ticket: Ticket): { draft: Content; saved: Content } {
  const current = { title: ticket.title, body: ticket.body };
  try {
    const raw = localStorage.getItem(draftKey(ticket.id));
    const value: unknown = raw ? JSON.parse(raw) : null;
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
  children,
  select,
  revision,
  mention = null,
}: {
  ticket: Ticket;
  onSaved: (ticket: Ticket) => void;
  children?: ReactNode;
  select?: (reference: string) => void;
  revision?: number;
  /** A description passage the person navigated here to read; null once they move on. */
  mention?: Mention | null;
}) {
  const [restored] = useState(() => restore(ticket));
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
  // Keep the unsaved text on this device, and write it once more as the page goes away.
  const ticketId = ticket.id;
  const latest = useRef({ draft, saved });
  useEffect(() => {
    latest.current = { draft, saved };
    storeDraft(ticketId, draft, saved);
  }, [draft, saved, ticketId]);
  useEffect(() => {
    const flush = () => {
      storeDraft(ticketId, latest.current.draft, latest.current.saved);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [ticketId]);
  // "idle" until something is saved, so an untouched ticket doesn't say "Saved".
  const [state, setState] = useState<"idle" | "saved" | "pending" | "failed">(
    "idle",
  );
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
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
      if (detail.reference === reference) {
        setBodyCaret(detail.documentId);
        setBodyMode("editing");
        setBodyFocus((count) => count + 1);
      }
    };
    window.addEventListener("ticketd:edit-description", edit);
    return () => window.removeEventListener("ticketd:edit-description", edit);
  }, [reference]);
  const editButton = useRef<HTMLButtonElement>(null);
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
    if (!dirty || externalChange || inFlight.current || state === "failed")
      return;
    const delay = immediate.current ? 0 : 500;
    const timer = window.setTimeout(() => {
      immediate.current = false;
      inFlight.current = true;
      setSaving(true);
      setState("pending");
      const patch: { title?: string; body?: string } = {};
      if (draft.title !== saved.title) patch.title = draft.title;
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
      void client
        .changeTicket(ticket.reference, guarded)
        .then((result) => {
          setSaved({ title: result.title, body: result.body });
          setDraft((current) => ({
            title: current.title === draft.title ? result.title : current.title,
            body: current.body === draft.body ? result.body : current.body,
          }));
          onSaved(result);
          setError("");
          setState("saved");
        })
        .catch(async (reason: unknown) => {
          if (String(reason).includes("changed elsewhere")) {
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
          setError(String(reason));
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
    draft,
    saved,
    dirty,
    externalChange,
    ticket.reference,
    onSaved,
    state,
    retry,
    saving,
  ]);

  function adoptSaved() {
    setDraft({ title: ticket.title, body: ticket.body });
    setSaved({ title: ticket.title, body: ticket.body });
    setConfirmSaved(false);
    setState("saved");
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
    <div role="status" className="editor-conflict">
      <p>
        {titleConflict && bodyConflict
          ? "The saved title and description"
          : titleConflict
            ? "The saved title"
            : "The saved description"}{" "}
        changed elsewhere{changedBy} while you were editing. Your unsaved draft
        is kept until you choose.
      </p>
      {titleConflict && (
        <p>
          Saved title: <strong>{ticket.title}</strong>
        </p>
      )}
      {confirmSaved ? (
        <div className="editor-conflict-actions">
          <span>Discard your unsaved draft?</span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => adoptSaved()}
            autoFocus
          >
            Discard draft
          </Button>
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
        </div>
      ) : (
        <>
          <div className="editor-conflict-actions">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() =>
                draftHasText ? setConfirmSaved(true) : adoptSaved()
              }
            >
              Use saved text
            </Button>
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
          </div>
          <p className="editor-conflict-help">
            Use saved text discards your draft. Keep my draft replaces the saved
            text with it.
          </p>
        </>
      )}
    </div>
  );
  function edit(next: Content) {
    setDraft(next);
    setState("pending");
  }
  return (
    <div className="ticket-editor">
      {titleConflict && !bodyConflict && notice}
      <label className="editor-title">
        <span className="sr-only">Title</span>
        <textarea
          ref={titleRef}
          aria-label="Title"
          rows={1}
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
        />
      </label>
      {children}
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
        <div className="description-heading">
          <span id={`body-${ticket.id}`}>Description</span>
          {editingBody ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setBodyMode("reading");
                window.requestAnimationFrame(() => editButton.current?.focus());
              }}
            >
              Done editing
            </Button>
          ) : draft.body ? (
            <Button
              ref={editButton}
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setBodyMode("editing")}
            >
              Edit description
            </Button>
          ) : null}
        </div>
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
                <p className="description-none">No description.</p>
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
              onChange={(body) => edit({ ...draft, body })}
              label="Description"
              autoFocus={editingBody}
              focusRequest={bodyFocus}
              {...(bodyCaret ? { focusLink: bodyCaret } : {})}
            />
          </div>
        )}
        {!editingBody &&
          (draft.body ? (
            <div
              ref={documentRef}
              className={`markdown-preview description-document${bodyConflict ? " conflict-draft" : ""}`}
              onClick={(event) => {
                const target = event.target;
                if (
                  target instanceof Element &&
                  target.closest(
                    "a, button, input, select, textarea, summary, [role=button]",
                  )
                )
                  return;
                if (window.getSelection()?.toString()) return;
                setBodyMode("editing");
              }}
            >
              <MarkdownDocument
                source={rendered}
                select={select}
                revision={revision}
                mention={mark}
              />
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="description-empty"
              ref={editButton}
              onClick={() => setBodyMode("editing")}
            >
              Add a description…
            </Button>
          ))}
      </div>
      <p role="status" className="editor-save-state">
        {saving
          ? "Saving…"
          : conflict
            ? "Unsaved — choose a version"
            : dirty && state !== "failed"
              ? "Pending save"
              : state === "failed"
                ? `${savedField} not saved`
                : state === "saved"
                  ? `${savedField} saved`
                  : ""}
      </p>
      {state === "failed" && (
        <div role="alert" className="document-save-error ticket-save-error">
          <p>Couldn&apos;t save your changes. Your draft is still here.</p>
          <Button
            size="sm"
            onClick={() => {
              setState("pending");
              setRetry((value) => value + 1);
            }}
          >
            Retry
          </Button>
          {error && (
            <details>
              <summary>Details</summary>
              <pre>{error}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
