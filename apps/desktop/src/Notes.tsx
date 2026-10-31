import { useCallback, useEffect, useState, type FormEvent } from "react";
import { client, type Note } from "./client";

export function Notes({ reference }: { reference: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const load = useCallback(async () => {
    try {
      const page = await client.notes(reference, 0);
      setNotes(page);
      setMore(page.length === 50);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [reference]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (editing) await client.editNote(reference, editing, content);
      else await client.addNote(reference, content);
      setContent("");
      setEditing(null);
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function remove(id: string) {
    try {
      await client.deleteNote(reference, id);
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function loadMore() {
    try {
      const page = await client.notes(reference, notes.length);
      setNotes((previous) => [...previous, ...page]);
      setMore(page.length === 50);
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <section className="mt-4" aria-label="Notes">
      <h3 className="font-semibold">Notes</h3>
      {error && <p role="alert">{error}</p>}
      <ol>
        {notes.map((note) => (
          <li key={note.id} className="my-3 border-b pb-2">
            <p className="whitespace-pre-wrap">{note.content}</p>
            <p className="text-sm">
              {note.created_at}
              {note.updated_at !== note.created_at &&
                ` · edited ${note.updated_at}`}
              {note.editing_agent && ` · ${note.editing_agent}`}
            </p>
            <button
              type="button"
              onClick={() => {
                setEditing(note.id);
                setContent(note.content);
              }}
            >
              Edit
            </button>
            {" · "}
            <button type="button" onClick={() => void remove(note.id)}>
              Delete
            </button>
          </li>
        ))}
      </ol>
      {more && (
        <button type="button" onClick={() => void loadMore()}>
          Load more notes
        </button>
      )}
      <form onSubmit={(event) => void save(event)} className="mt-3">
        <label className="block">
          {editing ? "Edit note" : "New note"}
          <textarea
            className="block w-full rounded border p-2"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            required
          />
        </label>
        <button type="submit">{editing ? "Save note" : "Add note"}</button>
        {editing && (
          <button
            type="button"
            className="ml-3"
            onClick={() => {
              setEditing(null);
              setContent("");
            }}
          >
            Cancel
          </button>
        )}
      </form>
    </section>
  );
}
