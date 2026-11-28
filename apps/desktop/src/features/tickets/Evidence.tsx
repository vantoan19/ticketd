import { useSources } from "@/features/settings/sources/use-sources";
import type { SourceEntry } from "@/lib/api/sources";
import { useStatusLine } from "@/components/ui/use-status-line";
import { Disclosure } from "@/components/ui/disclosure";
import { Pager } from "@/components/ui/pager";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { SectionHeader } from "@/components/ui/section-header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { CopyButton } from "@/components/ui/copy-button";
import { Picker } from "@/components/ui/picker";
import { Time } from "@/components/ui/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CheckCheck,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  MoreHorizontal,
} from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import "./evidence.css";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { revealInDetail } from "./detail-scroll";
import {
  client,
  type Evidence as EvidenceRecord,
  type EvidenceInput,
} from "@/lib/api/client";
import { useOpenTicket } from "@/features/tickets/open-ticket";

const evidenceIcons = {
  pull_request: GitPullRequest,
  commit: GitCommitHorizontal,
  branch: GitBranch,
  worktree: FolderGit2,
  verification: CheckCheck,
};

const noItems: EvidenceRecord[] = [];
const blank: EvidenceInput = {
  kind: "pull_request",
  name: "",
  value: "",
  editing_agent: null,
};
/** One name per type, in the rows and in the dialog (DB-26). */
const typeNames = {
  pull_request: "Pull request",
  commit: "Commit",
  branch: "Branch",
  worktree: "Worktree",
  verification: "Verification",
} as const;
/** What the value field asks for, by type. */
const valueLabels = {
  pull_request: "URL, reference, or path",
  commit: "URL, reference, or path",
  branch: "URL, reference, or path",
  worktree: "URL, reference, or path",
  verification: "What was checked and its outcome",
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
  trashed,
  folded = false,
  addRequest = 0,
  showRequest = 0,
  addTrigger,
}: {
  trashed: boolean;
  /**
   * With no evidence the section folds away; the context line offers Evidence….
   */
  folded?: boolean;
  /** Bump to open Add evidence from outside the section. */
  addRequest?: number;
  showRequest?: number;
  addTrigger?: HTMLElement | null;
}) {
  const { entries: sources } = useSources();
  const formId = useId();
  const statusLine = useStatusLine();
  const { record, changed: ticketChanged } = useOpenTicket();
  const reference = record.reference;
  // The Open Ticket serves the records, a page at a time, and re-reads every
  // page it has loaded whenever the workspace changes.
  const read = useOpenTicket("evidence");
  const loaded = read.value !== undefined;
  const items = read.value?.items ?? noItems;
  const total = read.value?.total ?? 0;
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement>(null);
  const show = useRef(showRequest);
  useLayoutEffect(() => {
    if (show.current === showRequest) return;
    show.current = showRequest;
    setExpanded(true);
    const heading = section.current?.querySelector<HTMLElement>(
      "[data-focus-target]",
    );
    if (heading) {
      heading.focus({ preventScroll: true });
      revealInDetail(heading);
    }
  }, [showRequest]);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<EvidenceInput>(blank);
  const [editing, setEditing] = useState<EvidenceRecord | null>(null);
  // The section's own failures (delete, open) and the dialog's own save
  // failure are kept apart, so neither shows up in the other's place. A
  // failure to read comes from the read and stays until a read succeeds.
  const [ownError, setError] = useState<FailureDescription | null>(null);
  const error = ownError ?? read.failure;
  const [dialogError, setDialogError] = useState<FailureDescription | null>(
    null,
  );
  const [deleteRetry, setDeleteRetry] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const pendingRef = useRef(false);
  function requestId(key: string) {
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    return request.current.id;
  }
  const menuTriggers = useRef(new Map<string, HTMLElement>());
  const returnFocus = useRef<HTMLElement | null>(null);
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
      await ticketChanged();
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
      const removed = items.find((item) => item.id === id);
      await client.deleteEvidence(reference, id, writeId);
      request.current = null;
      setDeleteRetry(null);
      setError(null);
      // Retry the same restoration intent if the write succeeded but its
      // reply or the subsequent reread was lost. A new ID could duplicate it.
      const restoreId = crypto.randomUUID();
      if (removed)
        statusLine.show({
          message: `Removed evidence ${removed.name}`,
          undo: async () => {
            await client.addEvidence(
              reference,
              {
                kind: removed.kind,
                name: removed.name,
                value: removed.value,
                editing_agent: removed.editing_agent,
              },
              restoreId,
            );
            setError(null);
            await ticketChanged();
          },
        });
      await ticketChanged();
    } catch (reason) {
      setDeleteRetry(id);
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
  function startAdding() {
    returnFocus.current = addTrigger ?? null;
    setDialogError(null);
    if (editing) {
      setEditing(null);
      setDraft(blank);
    }
    setComposing(true);
  }
  // The calm empty ticket's "+ Evidence" asks for the dialog from outside.
  const seenAddRequest = useRef(addRequest);
  useEffect(() => {
    if (addRequest === seenAddRequest.current) return;
    seenAddRequest.current = addRequest;
    startAdding();
  });
  const empty = loaded && total === 0;
  const hiddenCount = total - 3;
  const hiddenNames = items
    .slice(3, 5)
    .map((item) => item.name)
    .join(", ");
  const remainingNames = hiddenCount > 2 ? ` +${hiddenCount - 2}` : "";
  function evidenceRow(item: EvidenceRecord) {
    const Icon = evidenceIcons[item.kind];
    return (
      <li key={item.id} className="evidence-item">
        <span
          className="evidence-kind-icon"
          role="img"
          aria-label={typeNames[item.kind]}
        >
          <Icon aria-hidden="true" />
        </span>
        <strong className="evidence-item-name">{item.name}</strong>
        <EvidenceValue
          sources={sources}
          item={item}
          onOpenFailed={() => {
            setDeleteRetry(null);
            setError(
              plainFailure("Couldn't open the link", "Copy it instead."),
            );
          }}
        />
        <Time className="evidence-item-meta" value={item.created_at} />
        <span className="evidence-item-actions">
          <span className="evidence-reveal">
            <CopyButton label="Copy" subject={item.name} text={item.value} />
          </span>
          {!trashed && (
            <span className="evidence-reveal">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    ref={(element) => {
                      if (element) menuTriggers.current.set(item.id, element);
                      else menuTriggers.current.delete(item.id);
                    }}
                    tooltipSide="top"
                    type="button"
                    disabled={pending}
                    label={`Actions for ${item.name}`}
                  >
                    <MoreHorizontal />
                  </IconButton>
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void remove(item.id)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )}
        </span>
      </li>
    );
  }
  return (
    <section
      ref={section}
      aria-label="Evidence"
      className="evidence-section"
      hidden={empty && folded && !error}
    >
      <SectionHeader
        title="Evidence"
        level={2}
        count={total || undefined}
        focusTarget
      />
      {!loaded && !error && (
        <div role="status" aria-label="Loading evidence">
          <ol className="evidence-list" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <li key={row} className="evidence-item">
                <span className="evidence-kind-icon">
                  <Skeleton className="h-4 w-4" />
                </span>
                <Skeleton className="evidence-item-name h-4 w-28 max-w-full" />
                <Skeleton className="evidence-item-value h-4 w-24 max-w-full" />
                <Skeleton className="evidence-item-meta h-4 w-12" />
              </li>
            ))}
          </ol>
        </div>
      )}
      {empty && !folded && (
        <EmptyState size="inline" plain description="No evidence yet." />
      )}
      {error && !composing && (
        <FailureAlert
          size="compact"
          failure={error}
          onRetry={() => {
            if (deleteRetry) {
              void remove(deleteRetry);
              return;
            }
            setError(null);
            read.retry();
          }}
        />
      )}
      {items.length > 0 && (
        <ol className="evidence-list">{items.slice(0, 3).map(evidenceRow)}</ol>
      )}
      {hiddenCount > 0 && (
        <Disclosure
          label={`${hiddenCount} more: ${hiddenNames}${remainingNames}`}
          open={expanded}
          onOpenChange={setExpanded}
        >
          {expanded && (
            <>
              <ol className="evidence-list" start={4}>
                {items.slice(3).map(evidenceRow)}
              </ol>
              {read.more && <Pager noun="evidence" onMore={read.showMore} />}
            </>
          )}
        </Disclosure>
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
        description={
          editing
            ? "Change this record."
            : "Record a pull request, commit, branch, worktree, or verification for this ticket."
        }
        primaryLabel={editing ? "Save evidence" : "Add evidence"}
        blockedReason={
          !draft.name.trim()
            ? "Add a name to continue."
            : !draft.value.trim()
              ? "Add the evidence to continue."
              : pending
                ? "Saving…"
                : null
        }
        onSubmit={() => void save()}
        returnFocus={returnFocus}
      >
        {dialogError && <FailureAlert size="compact" failure={dialogError} />}
        {changed && (
          <Alert tone="attention" size="compact" role="status">
            <AlertDescription>
              This evidence changed while you were editing. Saving replaces it
              with your draft.
            </AlertDescription>
          </Alert>
        )}
        <fieldset disabled={pending}>
          <FieldGroup>
            <Field>
              <Picker
                label="Type"
                stacked
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
                options={Object.entries(typeNames).map(([key, label]) => ({
                  value: key,
                  label,
                }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                id={`${formId}-name`}
                required
                placeholder="e.g. Fix board jump"
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-value`}>
                {valueLabels[draft.kind]}
              </FieldLabel>
              <Textarea
                id={`${formId}-value`}
                required
                value={draft.value}
                onChange={(event) => {
                  const value = event.target.value;
                  // A pasted pull request link fills the type and a name (S11).
                  const pr = pullRequest(value.trim(), sources);
                  setDraft(
                    pr && !editing
                      ? {
                          ...draft,
                          value,
                          kind: "pull_request",
                          name: draft.name || `PR #${pr.number}`,
                        }
                      : { ...draft, value },
                  );
                }}
              />
            </Field>
          </FieldGroup>
        </fieldset>
      </DialogShell>
    </section>
  );
}

function pullRequest(value: string, sources: readonly SourceEntry[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const [owner, project, segment, number, ...rest] = url.pathname
    .replace(/^\/|\/$/g, "")
    .split("/");
  if (
    !owner ||
    !project ||
    !number ||
    !/^[0-9]+$/.test(number) ||
    rest.length > 0
  )
    return null;
  const recognized = sources.some(({ connector }) => {
    const link = connector.presentation?.pull_request_link;
    return (
      link && link.host === url.host && link.segment === segment?.toLowerCase()
    );
  });
  return recognized ? { repository: `${owner}/${project}`, number } : null;
}

/**
 * The record's value: a link that opens when it is an
 * address (a pull request reads "owner/repo #57"), a short commit with the
 * full hash in a tooltip, or the text itself.
 */
function EvidenceValue({
  item,
  sources,
  onOpenFailed,
}: {
  item: EvidenceRecord;
  sources: readonly SourceEntry[];
  onOpenFailed: () => void;
}) {
  if (/^https:\/\/\S+$/.test(item.value)) {
    const pr = pullRequest(item.value, sources);
    return (
      <Tooltip content={item.value}>
        <Button
          type="button"
          className="evidence-item-value"
          variant="link"
          size="inline"
          aria-label={`Open ${item.name}`}
          onClick={() =>
            void workspaceClient.openLink(item.value).catch(onOpenFailed)
          }
        >
          <span className="truncate">
            {pr ? `${pr.repository} #${pr.number}` : readableUrl(item.value)}
          </span>
        </Button>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={item.value}>
      <p
        className="evidence-item-value"
        data-kind={item.kind === "verification" ? "text" : "code"}
        tabIndex={0}
      >
        {item.kind === "commit" ? shortCommit(item.value) : item.value}
      </p>
    </Tooltip>
  );
}

/** An address without its scheme or a trailing slash: "example.com/runs/42". */
function readableUrl(value: string) {
  return value.replace(/^https:\/\//, "").replace(/\/$/, "");
}
