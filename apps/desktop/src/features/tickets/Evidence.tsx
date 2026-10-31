import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatWhen } from "./format-when";
import "./evidence.css";
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
const typeNames = {
  pull_request: "Pull request",
  commit: "Commit",
  branch: "Branch",
  worktree: "Worktree",
  verification: "Verification",
} as const;

export function Evidence({
  reference,
  revision,
  trashed,
  refresh,
}: {
  reference: string;
  revision: number;
  trashed: boolean;
  refresh: () => Promise<void>;
}) {
  const [composing, setComposing] = useState(false);
  const [items, setItems] = useState<EvidenceRecord[]>([]);
  const [draft, setDraft] = useState<EvidenceInput>(blank);
  const [editing, setEditing] = useState<EvidenceRecord | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const pendingRef = useRef(false);
  function requestId(key: string) {
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    return request.current.id;
  }
  const [more, setMore] = useState(false);
  const pages = useRef(1);
  const menuTriggers = useRef(new Map<string, HTMLElement>());
  const returnFocus = useRef<HTMLElement | null>(null);
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
    void Promise.resolve()
      .then(load)
      .catch((reason: unknown) => setError(String(reason)));
  }, [load, revision]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const id = requestId(
      JSON.stringify(["save", reference, editing?.id, draft]),
    );
    try {
      if (editing) await client.editEvidence(reference, editing.id, draft, id);
      else await client.addEvidence(reference, draft, id);
      request.current = null;
      setDraft(blank);
      setEditing(null);
      setComposing(false);
      setError("");
      await load();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  async function remove(id: string) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const writeId = requestId(JSON.stringify(["delete", reference, id]));
    try {
      await client.deleteEvidence(reference, id, writeId);
      request.current = null;
      setError("");
      await load();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
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
  function copy(item: EvidenceRecord) {
    const failure = "Could not copy the value. Select it above to copy it.";
    if (!navigator.clipboard) {
      setError(failure);
      return;
    }
    void navigator.clipboard
      .writeText(item.value)
      .then(() => {
        setCopied(item.id);
        setError("");
      })
      .catch(() => setError(failure));
  }
  function startAdding() {
    returnFocus.current = null;
    if (editing) {
      setEditing(null);
      setDraft(blank);
    }
    setComposing(true);
  }
  return (
    <section aria-label="Implementation evidence" className="evidence-section">
      <div className="evidence-heading">
        <h3>
          Implementation evidence{" "}
          <span className="text-muted-foreground">{items.length || ""}</span>
        </h3>
        {!trashed && items.length > 0 && (
          <Button variant="ghost" size="sm" onClick={startAdding}>
            <Plus data-icon="inline-start" />
            Add evidence
          </Button>
        )}
      </div>
      {!items.length && (
        <div className="evidence-empty">
          <p className="text-muted-foreground text-xs">
            Link a pull request, commit, or verification result.
          </p>
          {!trashed && (
            <Button variant="ghost" size="sm" onClick={startAdding}>
              <Plus data-icon="inline-start" />
              Add evidence
            </Button>
          )}
        </div>
      )}
      {error && !composing && <p role="alert">{error}</p>}
      <ol className="evidence-list">
        {items.map((item) => (
          <li key={item.id} className="evidence-item">
            <div className="evidence-item-heading">
              <strong>{item.name}</strong>
              <span title={item.updated_at}>
                {typeNames[item.kind]} · {formatWhen(item.updated_at)}
                {item.editing_agent && ` · ${item.editing_agent}`}
              </span>
              <span className="evidence-item-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Copy ${item.name}`}
                  onClick={() => copy(item)}
                >
                  {copied === item.id ? "Copied" : "Copy"}
                </Button>
                {!trashed && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        ref={(element) => {
                          if (element)
                            menuTriggers.current.set(item.id, element);
                          else menuTriggers.current.delete(item.id);
                        }}
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        disabled={pending}
                        aria-label={`Actions for ${item.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          // The menu closes as the dialog opens, so name the
                          // control focus should come back to.
                          returnFocus.current =
                            menuTriggers.current.get(item.id) ?? null;
                          setComposing(true);
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
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => void remove(item.id)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            </div>
            <p
              className="evidence-item-value"
              data-kind={item.kind === "verification" ? "text" : "code"}
            >
              {item.value}
            </p>
          </li>
        ))}
      </ol>
      {more && (
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => {
            pages.current += 1;
            void load().catch((reason: unknown) => setError(String(reason)));
          }}
        >
          Load more evidence
        </Button>
      )}
      <Dialog
        open={!trashed && composing}
        // Closing keeps the draft; only Cancel or a save clears it.
        onOpenChange={setComposing}
      >
        <DialogContent returnFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit evidence" : "Add evidence"}
            </DialogTitle>
            <DialogDescription>
              Record a pull request, commit, branch, worktree, or verification
              result for this ticket.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert">{error}</p>}
          {changed && (
            <p role="status">
              Saved evidence changed while you were editing. Your draft is
              preserved; saving will replace it.
            </p>
          )}
          <form onSubmit={(event) => void save(event)}>
            <fieldset disabled={pending}>
              <FieldGroup>
                <Field>
                  <label className="evidence-label">
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
                </Field>
                <Field>
                  <label className="evidence-label">
                    Name
                    <Input
                      required
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                    />
                  </label>
                </Field>
                <Field>
                  <label className="evidence-label">
                    {draft.kind === "verification"
                      ? "What was checked and its outcome"
                      : "URL, reference, or path"}
                    <Textarea
                      required
                      value={draft.value}
                      onChange={(event) =>
                        setDraft({ ...draft, value: event.target.value })
                      }
                    />
                  </label>
                </Field>
                <div className="flex gap-2">
                  <Button size="sm" type="submit">
                    {editing ? "Save evidence" : "Add evidence"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(null);
                      setComposing(false);
                      setDraft(blank);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </FieldGroup>
            </fieldset>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
