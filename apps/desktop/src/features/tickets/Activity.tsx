import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { client, type Note, type Project } from "@/lib/api/client";
import type { Effort } from "@/lib/api/efforts";
import { historyClient, type Entry } from "@/lib/api/history";
import { historySentence } from "./history-sentence";
import { formatDateTime } from "@/lib/format";
import "./activity.css";

/**
 * Unsubmitted note drafts by ticket reference. They outlive this component so
 * switching tickets, or the detail remounting, never loses typed text.
 */
const noteDrafts = new Map<string, string>();

export function Activity({
  reference,
  status,
  revision,
  projects,
  active,
  trashed,
  select,
  target,
  efforts = [],
}: {
  reference: string;
  status: string;
  revision: number;
  projects: Project[];
  active: boolean;
  trashed: boolean;
  select?: (reference: string) => void;
  target?: { id: string; key: number } | null;
  efforts?: Effort[];
}) {
  const [loadError, setLoadError] = useState("");
  const [targetNote, setTargetNote] = useState<Note | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const targetId = target?.id;
  const targetKey = target?.key;
  useEffect(() => {
    if (!active || targetId === undefined) return;
    let current = true;
    void client
      .note(reference, targetId)
      .then((note) => {
        if (current) setTargetNote(note);
      })
      .catch((reason: unknown) => {
        if (current) setLoadError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [active, reference, targetId, targetKey]);
  useEffect(() => {
    if (active && targetId !== undefined && targetNote?.id === targetId) {
      targetRef.current?.scrollIntoView?.({ block: "center" });
      targetRef.current?.focus({ preventScroll: true });
    }
  }, [active, targetId, targetKey, targetNote]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [history, setHistory] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraftValue] = useState(
    () => noteDrafts.get(reference) ?? "",
  );
  const [composing, setComposing] = useState(() => noteDrafts.has(reference));
  function setDraft(content: string) {
    if (content) noteDrafts.set(reference, content);
    else noteDrafts.delete(reference);
    setDraftValue(content);
  }
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
    const loaded: Note[] = [];
    let page: Note[] = [];
    for (let index = 0; index < pages.current; index++) {
      page = await client.notes(reference, index * 50);
      loaded.push(...page);
      if (page.length < 50) break;
    }
    setNotes(loaded);
    setMore(page.length === 50);
  }, [reference]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void Promise.resolve()
      .then(() => Promise.all([loadNotes(), historyClient.list(reference)]))
      .then(([, entries]) => {
        if (current) {
          setHistory(entries);
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
      !(edit ? edit.content : draft).trim()
    )
      return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      if (edit) await client.editNote(reference, edit.id, edit.content);
      else await client.addNote(reference, draft);
      if (edit) setEdit(null);
      else {
        setDraft("");
        setComposing(false);
      }
      await loadNotes();
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
      await client.deleteNote(reference, id);
      await loadNotes();
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
      const page = await client.notes(reference, notes.length);
      pages.current += 1;
      setNotes((previous) => [...previous, ...page]);
      setMore(page.length === 50);
    } catch (reason) {
      setError(String(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const changed =
    edit &&
    !notes.some(
      (note) => note.id === edit.id && note.content === edit.original,
    );
  const entries = [
    ...notes.map((note) => ({
      type: "note" as const,
      timestamp: note.created_at,
      note,
    })),
    ...history.map((entry, index) => ({
      type: "history" as const,
      timestamp: entry.timestamp,
      entry,
      index,
    })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const lookups = {
    project: (id: string) =>
      projects.find((project) => project.id === id)?.name,
    effort: (id: string) => efforts.find((effort) => effort.id === id)?.name,
  };
  const draftText = edit ? edit.content : draft;
  return (
    <section className="activity" aria-label="Activity">
      {active && target && targetNote?.id === target.id && (
        <div ref={targetRef} tabIndex={-1} aria-label="Selected note">
          <strong>Selected note</strong>
          <MarkdownDocument
            source={targetNote.content}
            select={select}
            revision={revision}
          />
        </div>
      )}
      <div className="activity-heading">
        <h3>Activity</h3>
      </div>
      {(error || loadError) && (
        <Alert variant="destructive">
          <AlertDescription>{error || loadError}</AlertDescription>
        </Alert>
      )}
      {loading && entries.length === 0 ? (
        <p className="activity-muted" role="status">
          Loading activity…
        </p>
      ) : entries.length === 0 && !error && !loadError ? (
        <Empty className="activity-empty">
          <EmptyHeader>
            <EmptyDescription>
              No notes or recorded changes yet.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="activity-list">
          {entries.map((item) =>
            item.type === "note" ? (
              <li key={`note-${item.note.id}`} className="activity-entry">
                <div className="activity-meta">
                  <time
                    dateTime={item.note.created_at}
                    title={item.note.created_at}
                  >
                    {formatDateTime(item.note.created_at)}
                  </time>
                  {item.note.updated_at !== item.note.created_at && (
                    <span title={item.note.updated_at}>
                      Edited {formatDateTime(item.note.updated_at)}
                    </span>
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
                          aria-label={`Actions for note from ${formatDateTime(item.note.created_at)}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() =>
                            setEdit({
                              id: item.note.id,
                              original: item.note.content,
                              content: item.note.content,
                            })
                          }
                        >
                          Edit note
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => void remove(item.note.id)}
                        >
                          Delete note
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <div className="markdown-preview activity-note">
                  <MarkdownDocument
                    source={item.note.content}
                    select={select}
                    revision={revision}
                  />
                </div>
              </li>
            ) : (
              <li key={`history-${item.index}`} className="activity-history">
                <span>{historySentence(item.entry, lookups)}</span>
                <time
                  dateTime={item.entry.timestamp}
                  title={item.entry.timestamp}
                >
                  {formatDateTime(item.entry.timestamp)}
                </time>
                {item.entry.editing_agent && (
                  <span>Agent: {item.entry.editing_agent}</span>
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
          Load more notes
        </Button>
      )}
      {!trashed && !composing && !edit && (
        <button
          type="button"
          className="activity-compact-composer"
          onClick={() => setComposing(true)}
        >
          Add a note
        </button>
      )}
      {!trashed && (composing || edit) && (
        <form
          className="activity-composer"
          onSubmit={(event) => void save(event)}
        >
          <FieldGroup>
            <Field data-disabled={pending}>
              <FieldLabel asChild>
                <span>{edit ? "Edit note" : "New note"}</span>
              </FieldLabel>
              <LazyMarkdownEditor
                key={edit?.id ?? "new"}
                label={edit ? "Edit note" : "New note"}
                value={draftText}
                onChange={(content) =>
                  edit ? setEdit({ ...edit, content }) : setDraft(content)
                }
                readOnly={pending}
              />
              <FieldDescription>Markdown is supported.</FieldDescription>
            </Field>
          </FieldGroup>
          {changed && (
            <p role="status" className="activity-muted">
              The saved note changed while you were editing. Your draft is
              preserved; saving will replace the saved content.
            </p>
          )}
          <div className="activity-actions">
            <Button
              type="submit"
              size="sm"
              disabled={pending || !draftText.trim()}
            >
              {pending ? "Saving…" : edit ? "Save note" : "Add note"}
            </Button>
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
                  setComposing(false);
                }}
              >
                Discard draft
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
