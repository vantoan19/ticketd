import { client } from "@/lib/api/client";
import { useState, type FormEvent } from "react";

export function Tags({
  reference,
  tags,
  refresh,
}: {
  reference: string;
  tags: string[];
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function change(command: "add_tag" | "remove_tag", tag: string) {
    setSaving(true);
    try {
      await client.changeTag(command, reference, tag);
      setName("");
      setError("");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change("add_tag", name);
  }
  return (
    <section className="mt-4" aria-label="Tags">
      <h4 className="font-semibold">Tags</h4>
      <p className="text-sm text-neutral-600">
        Names are trimmed and lowercased; duplicate tags are ignored.
      </p>
      <ul>
        {tags.map((tag) => (
          <li key={tag}>
            {tag}{" "}
            <button
              type="button"
              disabled={saving}
              onClick={() => void change("remove_tag", tag)}
              aria-label={`Remove ${tag} tag`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-2 flex gap-2">
        <label>
          Tag name{" "}
          <input
            className="rounded border border-neutral-400 p-1"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <button
          className="rounded border border-neutral-400 px-2"
          disabled={saving}
        >
          Add tag
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
