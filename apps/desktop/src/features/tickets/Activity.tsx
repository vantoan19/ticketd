import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { client, type Note, type Project } from "@/lib/api/client";
import { historyClient, type Entry } from "@/lib/api/history";
import "./activity.css";

export function Activity({
  reference,
  status,
  revision,
  projects,
  active,
  trashed,
}: {
  reference: string;
  status: string;
  revision: number;
  projects: Project[];
  active: boolean;
  trashed: boolean;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [history, setHistory] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
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
    setLoading(true);
    void Promise.all([loadNotes(), historyClient.list(reference)])
      .then(([, entries]) => {
        if (current) {
          setHistory(entries);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
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
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      if (edit) await client.editNote(reference, edit.id, edit.content);
      else await client.addNote(reference, draft);
      if (edit) setEdit(null);
      else setDraft("");
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
  function historyValue(entry: Entry, value: string) {
    if (entry.kind !== "project") return value;
    return value
      ? (projects.find((project) => project.id === value)?.name ?? value)
      : "Unlinked";
  }
  return (
    <section className="activity" aria-label="Activity">
      <div className="activity-heading">
        <h3>Activity</h3>
        <span>Notes and recorded changes</span>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && entries.length === 0 ? (
        <p className="activity-muted" role="status">
          Loading activity…
        </p>
      ) : entries.length === 0 && !error ? (
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
                  <strong>Note</strong>
                  <time dateTime={item.note.created_at}>
                    {item.note.created_at}
                  </time>
                  {item.note.updated_at !== item.note.created_at && (
                    <span>Edited {item.note.updated_at}</span>
                  )}
                  {item.note.editing_agent && (
                    <span>Agent: {item.note.editing_agent}</span>
                  )}
                </div>
                <div className="markdown-preview activity-note">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.note.content}
                  </ReactMarkdown>
                </div>
                {!trashed && (
                  <div className="activity-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Edit note from ${item.note.created_at}`}
                      onClick={() =>
                        setEdit({
                          id: item.note.id,
                          original: item.note.content,
                          content: item.note.content,
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Delete note from ${item.note.created_at}`}
                      onClick={() => void remove(item.note.id)}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ) : (
              <li key={`history-${item.index}`} className="activity-entry">
                <div className="activity-meta">
                  <strong>History</strong>
                  <time dateTime={item.entry.timestamp}>
                    {item.entry.timestamp}
                  </time>
                  {item.entry.editing_agent && (
                    <span>Agent: {item.entry.editing_agent}</span>
                  )}
                </div>
                <p>
                  {item.entry.kind}:{" "}
                  {historyValue(item.entry, item.entry.from_value)} →{" "}
                  {historyValue(item.entry, item.entry.to_value)}
                </p>
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
      {!trashed && (
        <form
          className="activity-composer"
          onSubmit={(event) => void save(event)}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`note-${reference}`}>
                {edit ? "Edit note" : "New note"}
              </FieldLabel>
              <textarea
                id={`note-${reference}`}
                value={edit ? edit.content : draft}
                onChange={(event) =>
                  edit
                    ? setEdit({ ...edit, content: event.target.value })
                    : setDraft(event.target.value)
                }
                required
                disabled={pending}
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
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : edit ? "Save note" : "Add note"}
            </Button>
            {edit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setEdit(null)}
              >
                Cancel edit
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
