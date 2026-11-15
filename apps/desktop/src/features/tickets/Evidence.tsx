import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { MoreHorizontal, Plus } from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { workspaceClient } from "@/lib/api/workspace";
import { FailureAlert } from "@/components/ui/failure-alert";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  sentence,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { formatDateTime } from "@/lib/format";
import { useCopy } from "@/components/ui/use-copy";
import "./evidence.css";
import { useCallback, useEffect, useRef, useState } from "react";
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

/** A failure the page knows the words for, with nothing to put under Details. */
function plainFailure(title: string, text: string): FailureDescription {
  return { code: "failed", title, sentence: text, action: null, details: "" };
}

/** A rejected save: the core's validation sentence without its prefix. */
function saveFailure(reason: unknown, editing: boolean): FailureDescription {
  const failure = describeFailure(
    reason,
    editing ? "save the evidence" : "add the evidence",
  );
  const { message } = toFailure(reason);
  return message.startsWith("invalid evidence: ")
    ? {
        ...failure,
        sentence: sentence(message.slice("invalid evidence: ".length)),
        action: null,
      }
    : failure;
}

/** A commit is read by its first characters; the full value stays in the tooltip and in Copy. */
function shortCommit(value: string): string {
  return /^[0-9a-f]{12,}$/i.test(value) ? value.slice(0, 10) : value;
}

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
  // The section's failures (load, delete, copy, open) and the dialog's own
  // save failure are kept apart, so neither shows up in the other's place.
  const [error, setError] = useState<FailureDescription | null>(null);
  const [dialogError, setDialogError] = useState<FailureDescription | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<EvidenceRecord | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const { copied, copy: copyText } = useCopy();
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
      .catch((reason: unknown) =>
        setError(describeFailure(reason, "load evidence")),
      );
  }, [load, revision]);
  async function save() {
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
      setDialogError(null);
      await load();
      await refresh();
    } catch (reason) {
      setDialogError(saveFailure(reason, Boolean(editing)));
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
      setConfirmDelete(null);
      setError(null);
      await load();
      await refresh();
    } catch (reason) {
      setError(describeFailure(reason, "delete the evidence"));
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
  async function copy(item: EvidenceRecord) {
    setError(
      (await copyText(item.id, item.value))
        ? null
        : plainFailure(
            "Couldn't copy the value",
            "Select it above to copy it.",
          ),
    );
  }
  function startAdding() {
    returnFocus.current = null;
    setDialogError(null);
    if (editing) {
      setEditing(null);
      setDraft(blank);
    }
    setComposing(true);
  }
  return (
    <section aria-label="Evidence" className="evidence-section">
      <SectionHeader
        title="Evidence"
        count={items.length || undefined}
        actions={
          !trashed && (
            <Button variant="ghost" size="sm" onClick={startAdding}>
              <Plus data-icon="inline-start" />
              Add evidence
            </Button>
          )
        }
      />
      {!items.length && (
        <EmptyState
          size="inline"
          plain
          description="Link a pull request, commit, or verification result."
        />
      )}
      {error && !composing && (
        <FailureAlert
          size="compact"
          failure={error}
          onRetry={() => {
            setError(null);
            void load().catch((reason: unknown) =>
              setError(describeFailure(reason, "load evidence")),
            );
          }}
        />
      )}
      {confirmDelete && (
        <p role="alertdialog" className="evidence-confirm">
          Delete evidence “{confirmDelete.name}”?
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => void remove(confirmDelete.id)}
          >
            Delete evidence
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(null)}
          >
            Keep evidence
          </Button>
        </p>
      )}
      <ol className="evidence-list">
        {items.map((item) => (
          <li key={item.id} className="evidence-item">
            <div className="evidence-item-heading">
              <span className="evidence-item-title">
                <strong>{item.name}</strong>
                <span className="evidence-item-meta" title={item.updated_at}>
                  {typeNames[item.kind]} · {formatDateTime(item.updated_at)}
                  {item.editing_agent && ` · ${item.editing_agent}`}
                </span>
              </span>
              <span className="evidence-item-actions">
                {/^https:\/\/\S+$/.test(item.value) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    aria-label={`Open ${item.name}`}
                    onClick={() =>
                      void workspaceClient
                        .openLink(item.value)
                        .catch(() =>
                          setError(
                            plainFailure(
                              "Couldn't open the link",
                              "Copy it instead.",
                            ),
                          ),
                        )
                    }
                  >
                    Open
                  </Button>
                )}
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
                          setDialogError(null);
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
                        onSelect={() => setConfirmDelete(item)}
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
              title={item.kind === "commit" ? item.value : undefined}
            >
              {item.kind === "commit" ? shortCommit(item.value) : item.value}
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
            void load().catch((reason: unknown) =>
              setError(describeFailure(reason, "load more evidence")),
            );
          }}
        >
          Load more evidence
        </Button>
      )}
      <DialogShell
        open={!trashed && composing}
        // Escape and an outside click keep the draft; Cancel or a save clears it.
        onOpenChange={setComposing}
        onCancel={() => {
          setDraft(blank);
          setEditing(null);
          setDialogError(null);
        }}
        title={editing ? "Edit evidence" : "Add evidence"}
        description="Record a pull request, commit, branch, worktree, or verification result for this ticket."
        primaryLabel={editing ? "Save evidence" : "Add evidence"}
        blockedReason={
          !draft.name.trim()
            ? "Add a name to continue"
            : !draft.value.trim()
              ? "Add the evidence to continue"
              : pending
                ? "Saving…"
                : null
        }
        onSubmit={() => void save()}
        returnFocus={returnFocus}
      >
        {dialogError && <FailureAlert size="compact" failure={dialogError} />}
        {changed && (
          <p role="status">
            Saved evidence changed while you were editing. Your draft is
            preserved; saving will replace it.
          </p>
        )}
        <fieldset disabled={pending}>
          <FieldGroup>
            <Field>
              <Picker
                label="Type"
                value={draft.kind}
                onValueChange={(value) => {
                  if (
                    value === "pull_request" ||
                    value === "commit" ||
                    value === "branch" ||
                    value === "worktree" ||
                    value === "verification"
                  )
                    setDraft({ ...draft, kind: value });
                }}
                options={Object.entries(labels).map(([key, label]) => ({
                  value: key,
                  label,
                }))}
              />
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
          </FieldGroup>
        </fieldset>
      </DialogShell>
    </section>
  );
}
