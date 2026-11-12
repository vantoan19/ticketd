import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { Folder, Layers } from "lucide-react";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { Picker } from "@/components/ui/picker";
import { Switch } from "@/components/ui/switch";
import { TokenField } from "@/components/ui/token-field";
import { client, type Project } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { directStatuses } from "@/lib/statuses";
import { modifierKeyLabel } from "@/lib/platform";
import { loadPreferences } from "@/lib/preferences";
import { z } from "zod";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import "./create-ticket.css";

// Select items cannot have an empty value, so "none" stands for no Project or Plan.
const NONE = "none";

type Draft = {
  title: string;
  body: string;
  status: string;
  project: string;
  plan: string;
  tags: string[];
  restored: boolean;
  requestId?: string | undefined;
  followCreated?: boolean | undefined;
  createMore?: boolean | undefined;
};
const draftSchema = z.object({
  title: z.string(),
  body: z.string(),
  status: z.string(),
  project: z.string(),
  plan: z.string(),
  tags: z.array(z.string()),
  restored: z.boolean(),
  requestId: z.string().uuid().optional(),
  followCreated: z.boolean().optional(),
  createMore: z.boolean().optional(),
});
export function CreateTicketDialog({
  open,
  onOpenChange,
  triggerRef,
  navigation,
  initialStatus,
  projects,
  plans,
  create,
}: {
  open: boolean;
  /** The status a status group's Add action starts the ticket with. */
  initialStatus?: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  navigation: { project: string; plan: string };
  projects: Project[];
  plans: Plan[];
  create: (
    title: string,
    body: string,
    status: string,
    project: string | null,
    plan: string | null,
    tags: string[],
    keepOpen: boolean,
    requestId?: string,
    followCreated?: boolean,
  ) => Promise<string>;
}) {
  const recovery = useDraftRecovery();
  const [draft, setDraft] = useState<Draft | null>(() => {
    const saved = recovery.read("new-ticket", draftSchema);
    return saved ? { ...saved, restored: true } : null;
  });
  const [editorGeneration, setEditorGeneration] = useState(0);
  useEffect(() => {
    const payload =
      draft && (draft.requestId || draft.title || draft.body) ? draft : null;
    void recovery
      .put("new-ticket", payload, draft?.body ? [draft.body] : [])
      .catch(() => {});
  }, [draft, recovery]);
  const [error, setError] = useState("");
  const [confirmNewTicket, setConfirmNewTicket] = useState(false);
  const [pending, setPending] = useState(false);
  const [completedCreation, setCompletedCreation] = useState<{
    reference: string;
    createMore: boolean;
  } | null>(null);
  const lock = useRef(false);
  // Title is disabled while creating, and a disabled field cannot take focus,
  // so Create more asks for focus once the field is enabled again.
  const refocusTitle = useRef(false);
  useEffect(() => {
    if (!pending && refocusTitle.current) {
      refocusTitle.current = false;
      titleRef.current?.focus();
    }
  }, [pending]);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [createMore, setCreateMore] = useState(draft?.createMore ?? false);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  // Opening from a status group's Add action sets that status, even on a
  // draft kept from an earlier close.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && draft && initialStatus && !draft.requestId)
      setDraft({ ...draft, status: initialStatus });
  }
  if (open && !draft)
    setDraft({
      title: "",
      body: "",
      status: initialStatus ?? "Todo",
      project:
        navigation.project === "all" || navigation.project === "unlinked"
          ? ""
          : navigation.project,
      plan: navigation.plan,
      tags: [],
      restored: false,
    });
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void client
        .searchTags("")
        .then((tags) => {
          if (active) setVocabulary(tags);
        })
        .catch(() => {
          if (active) setVocabulary([]);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open]);
  if (!draft) return null;
  const update = (patch: Partial<Draft>) =>
    setDraft((old) => old && { ...old, ...patch });
  function close() {
    if (completedCreation) return;
    const dirty = !!(
      draft!.requestId ||
      draft!.title.trim() ||
      draft!.body.trim()
    );
    if (dirty) update({ restored: true });
    else setDraft(null);
    setConfirmNewTicket(false);
    setAnnouncement("");
    onOpenChange(false);
  }
  async function submit() {
    const currentDraft = draft!;
    if (
      lock.current ||
      (!completedCreation &&
        !currentDraft.requestId &&
        !currentDraft.title.trim())
    )
      return;
    setError("");
    lock.current = true;
    setPending(true);
    let submittedCreation = completedCreation;
    let submission = currentDraft;
    let creationAttempted = false;
    try {
      if (!submittedCreation) {
        submission = {
          ...currentDraft,
          requestId: currentDraft.requestId ?? crypto.randomUUID(),
          followCreated:
            currentDraft.followCreated ?? loadPreferences().followCreated,
          createMore,
        };
        setDraft(submission);
        recovery.retry();
        await recovery.put(
          "new-ticket",
          submission,
          submission.body ? [submission.body] : [],
        );
        await recovery.flush();
        creationAttempted = true;
        const reference = await create(
          submission.title,
          submission.body,
          submission.status,
          submission.project || null,
          submission.plan || null,
          submission.tags,
          createMore,
          submission.requestId,
          submission.followCreated,
        );
        submittedCreation = { reference, createMore };
        setCompletedCreation(submittedCreation);
      }
      // A failed release is cached by the recovery store. Finish cleanup must
      // clear and retry that failure itself before deciding the draft is gone.
      recovery.retry();
      await recovery.flush();
      await recovery.put("new-ticket", null, []);
      setCompletedCreation(null);
      setEditorGeneration((value) => value + 1);
      if (submittedCreation.createMore) {
        setDraft({
          title: "",
          body: "",
          status: submission.status,
          project: submission.project,
          plan: submission.plan,
          tags: submission.tags,
          restored: false,
        });
        setAnnouncement(`Created ${submittedCreation.reference}`);
        refocusTitle.current = true;
      } else setDraft(null);
    } catch (reason) {
      setError(
        submittedCreation
          ? `Ticket ${submittedCreation.reference} was created, but its draft could not be cleared: ${String(reason)}`
          : creationAttempted
            ? `Could not confirm whether the ticket was created. Retry safely with the same submission: ${String(reason)}`
            : `Could not save the submission for a safe retry; no ticket was created: ${String(reason)}`,
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  async function editAsNewTicket() {
    if (lock.current || completedCreation) return;
    const next = { ...draft!, restored: true };
    delete next.requestId;
    delete next.followCreated;
    delete next.createMore;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      recovery.retry();
      await recovery.put("new-ticket", next, next.body ? [next.body] : []);
      await recovery.flush();
      setDraft(next);
      setConfirmNewTicket(false);
      refocusTitle.current = true;
    } catch (reason) {
      setError(
        `Could not save the edited draft. The original submission is still available to retry: ${String(reason)}`,
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  const suggestions = vocabulary
    .filter((tag) => !draft.tags.includes(tag))
    .slice(0, 6);
  const hasSubmission = !!draft.requestId;
  const fieldsLocked = pending || hasSubmission || !!completedCreation;
  const primaryLabel = completedCreation
    ? "Finish cleanup"
    : hasSubmission
      ? "Retry safely"
      : "Create ticket";
  const blockedReason =
    !hasSubmission && !draft.title.trim()
      ? "Add a title to create"
      : pending
        ? "Creating…"
        : null;
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="New ticket"
      primaryLabel={primaryLabel}
      primaryHint={`${modifierKeyLabel()}↵`}
      footerLeading={
        <label className="create-more">
          <Switch
            checked={createMore}
            onCheckedChange={setCreateMore}
            disabled={fieldsLocked}
            aria-label="Create more"
          />
          <span>Create more</span>
        </label>
      }
      blockedReason={blockedReason}
      onSubmit={() => void submit()}
      returnFocus={triggerRef}
      busy={pending || !!completedCreation}
    >
      <div
        className="create-form flex flex-col gap-4"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.currentTarget.closest("form")?.requestSubmit();
          }
        }}
      >
        <fieldset disabled={fieldsLocked} className="contents">
          <Field data-disabled={fieldsLocked}>
            <FieldLabel htmlFor="create-title">Title</FieldLabel>
            <Input
              id="create-title"
              ref={titleRef}
              autoFocus
              placeholder="e.g. Export fails on large workspaces"
              disabled={fieldsLocked}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field data-disabled={fieldsLocked}>
            <FieldLabel asChild>
              <span>
                Description <small>Optional</small>
              </span>
            </FieldLabel>
            <div
              // The editor owns its keys (Enter, slash menu, IME, Escape,
              // CodeMirror bindings), so they stop here. The one exception is
              // a Cmd/Ctrl+Enter that the rich editor left unhandled: it
              // creates the ticket. Nested UI (slash menu, link field, source
              // editors) handles or ignores it first, so it never reaches here
              // as an unhandled rich-editor event.
              // The box keeps its 112px height while the editor loads, and the
              // hint sits inside it at the bottom.
              className="create-description"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  event.ctrlKey !== event.metaKey &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.defaultPrevented &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229 &&
                  (event.target as HTMLElement).closest(".rich-document")
                ) {
                  event.preventDefault();
                  event.currentTarget.closest("form")?.requestSubmit();
                }
                event.stopPropagation();
              }}
            >
              <LazyMarkdownEditor
                key={editorGeneration}
                recoveryOwner="new-ticket"
                label="Description"
                placeholder="Steps, acceptance criteria, or a checklist"
                readOnly={fieldsLocked}
                value={draft.body}
                onChange={(body) => update({ body })}
              />
              <small className="create-description-hint">
                Markdown works · type / for blocks
              </small>
            </div>
          </Field>
          {draft.restored && (
            <p className="create-restored" role="status">
              Draft restored.{" "}
              <Button
                type="button"
                variant="link"
                size="sm"
                disabled={fieldsLocked || hasSubmission}
                onClick={() => {
                  update({ title: "", body: "", restored: false });
                  setEditorGeneration((value) => value + 1);
                  titleRef.current?.focus();
                }}
              >
                Discard draft
              </Button>
            </p>
          )}
          <div
            className="create-properties"
            role="group"
            aria-label="Initial properties"
          >
            <Picker
              label="Status"
              stacked
              icon={<StatusIcon status={draft.status} size={16} decorative />}
              value={draft.status}
              disabled={fieldsLocked}
              onValueChange={(status) => update({ status })}
              options={directStatuses.map((status) => ({
                value: status,
                label: status,
              }))}
            />
            <Picker
              label="Project"
              stacked
              icon={<Folder aria-hidden="true" />}
              value={draft.project || NONE}
              disabled={fieldsLocked}
              onValueChange={(project) =>
                update({ project: project === NONE ? "" : project })
              }
              options={[
                { value: NONE, label: "No project" },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            <Picker
              label="Plan"
              stacked
              icon={<Layers aria-hidden="true" />}
              value={draft.plan || NONE}
              disabled={fieldsLocked}
              onValueChange={(plan) =>
                update({ plan: plan === NONE ? "" : plan })
              }
              options={[
                { value: NONE, label: "No Plan" },
                ...plans
                  .filter((e) => !e.archived)
                  .map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span aria-hidden="true">Tags</span>
            <TokenField
              label="Add tag"
              chevron
              placeholder="Add a tag"
              suggestions={suggestions}
              values={draft.tags}
              onChange={(tags) =>
                update({ tags: tags.map((tag) => tag.toLowerCase()) })
              }
            />
          </div>
        </fieldset>
        {error && (
          <Alert tone="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {hasSubmission &&
          !completedCreation &&
          (confirmNewTicket ? (
            <div className="flex flex-col gap-2">
              <p role="status">
                Your earlier ticket may already exist. Editing as a new ticket
                can create another one.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setConfirmNewTicket(false)}
                >
                  Keep retrying
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void editAsNewTicket()}
                >
                  Edit as new ticket
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmNewTicket(true)}
            >
              Edit draft
            </Button>
          ))}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>
    </DialogShell>
  );
}
