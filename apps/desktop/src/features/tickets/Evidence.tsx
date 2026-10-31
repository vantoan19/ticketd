import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  client,
  type Evidence as EvidenceRecord,
  type EvidenceInput,
} from "@/lib/api/client";

const blank: EvidenceInput = {
  kind: "pull_request",
  name: "",
  value: "",
  editing_agent: null,
};
const labels = {
  pull_request: "Pull request URL",
  commit: "Commit",
  branch: "Branch",
  worktree: "Worktree path",
  verification: "Verification result",
} as const;

export function Evidence({
  reference,
  revision,
  trashed,
}: {
  reference: string;
  revision: number;
  trashed: boolean;
}) {
  const [items, setItems] = useState<EvidenceRecord[]>([]);
  const [draft, setDraft] = useState<EvidenceInput>(blank);
  const [editing, setEditing] = useState<EvidenceRecord | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const pages = useRef(1);
  const load = useCallback(async () => {
    const all: EvidenceRecord[] = [];
    let page: EvidenceRecord[] = [];
    for (let index = 0; index < pages.current; index++) {
      page = await client.evidence(reference, index * 50);
      all.push(...page);
      if (page.length < 50) break;
    }
    setItems(all);
    setMore(page.length === 50);
  }, [reference]);
  useEffect(() => {
    void load().catch((reason: unknown) => setError(String(reason)));
  }, [load, revision]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (editing) await client.editEvidence(reference, editing.id, draft);
      else await client.addEvidence(reference, draft);
      setDraft(blank);
      setEditing(null);
      setError("");
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function remove(id: string) {
    try {
      await client.deleteEvidence(reference, id);
      setError("");
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  const current = editing && items.find((item) => item.id === editing.id);
  const changed =
    editing &&
    (!current ||
      current.updated_at !== editing.updated_at ||
      current.value !== editing.value ||
      current.name !== editing.name ||
      current.kind !== editing.kind);
  return (
    <section aria-label="Implementation evidence" className="mt-4">
      <h3>Implementation evidence</h3>
      {error && <p role="alert">{error}</p>}
      <ol>
        {items.map((item) => (
          <li key={item.id} className="my-3 border-b pb-2">
            <strong>{item.name}</strong> · {labels[item.kind]}
            <p className="whitespace-pre-wrap break-all">{item.value}</p>
            <p>
              {item.updated_at}
              {item.editing_agent && ` · ${item.editing_agent}`}
            </p>
            {!trashed && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(item);
                    setDraft({
                      kind: item.kind,
                      name: item.name,
                      value: item.value,
                      editing_agent: item.editing_agent,
                    });
                  }}
                >
                  Edit
                </button>
                {" · "}
                <button type="button" onClick={() => void remove(item.id)}>
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {more && (
        <button
          type="button"
          onClick={() => {
            pages.current += 1;
            void load().catch((reason: unknown) => setError(String(reason)));
          }}
        >
          Load more evidence
        </button>
      )}
      {changed && (
        <p role="status">
          Saved evidence changed while you were editing. Your draft is
          preserved; saving will replace it.
        </p>
      )}
      {!trashed && (
        <form onSubmit={(event) => void save(event)} className="mt-3">
          <label className="block">
            Type
            <select
              value={draft.kind}
              onChange={(event) => {
                const kind = Object.keys(labels).find(
                  (key) => key === event.target.value,
                );
                if (
                  kind === "pull_request" ||
                  kind === "commit" ||
                  kind === "branch" ||
                  kind === "worktree" ||
                  kind === "verification"
                )
                  setDraft({ ...draft, kind });
              }}
            >
              {Object.entries(labels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Name
            <input
              className="block w-full rounded border p-2"
              required
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label className="block">
            {draft.kind === "verification"
              ? "What was checked and its outcome"
              : "URL, reference, or path"}
            <textarea
              className="block w-full rounded border p-2"
              required
              value={draft.value}
              onChange={(event) =>
                setDraft({ ...draft, value: event.target.value })
              }
            />
          </label>
          <button type="submit">
            {editing ? "Save evidence" : "Add evidence"}
          </button>
          {editing && (
            <button
              type="button"
              className="ml-3"
              onClick={() => {
                setEditing(null);
                setDraft(blank);
              }}
            >
              Cancel
            </button>
          )}
        </form>
      )}
    </section>
  );
}
