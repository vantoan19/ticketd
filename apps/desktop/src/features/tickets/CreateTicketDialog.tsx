import { useEffect, useRef, useState, type RefObject } from "react";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { Field } from "@/components/ui/field";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { TITLE_MAX_LENGTH } from "@/lib/limits";
import { Folder, Layers, Tags, Maximize2, Minimize2 } from "lucide-react";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { DraftPropertyPicker, DraftBlockerPicker } from "./DraftPropertyPicker";
import { IconButton } from "@/components/ui/icon-button";
import { matchesShortcut, shortcutLabel } from "@/lib/shortcuts";
import { Switch } from "@/components/ui/switch";
import { client, type Project } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { directStatuses } from "@/lib/statuses";
import { loadPreferences } from "@/lib/preferences";
import { z } from "zod";
import {
  DraftRecoveryGate,
  useDraftRecovery,
} from "@/lib/draft-recovery-context";
import "./create-ticket.css";

type Draft = {
  title: string;
  body: string;
  status: string;
  project: string;
  plan: string;
  tags: string[];
  blockers?: string[] | undefined;
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
  blockers: z.array(z.string()).optional(),
  restored: z.boolean(),
  requestId: z.string().uuid().optional(),
  followCreated: z.boolean().optional(),
  createMore: z.boolean().optional(),
});
type CreateTicketDialogProps = {
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
    blockers?: string[],
  ) => Promise<string>;
};

/** Opens once stored recovery has loaded, so an unsent ticket comes back with it. */
export function CreateTicketDialog(props: CreateTicketDialogProps) {
  return (
    <DraftRecoveryGate>
      <RecoveredCreateTicketDialog {...props} />
    </DraftRecoveryGate>
  );
}

function RecoveredCreateTicketDialog({
  open,
  onOpenChange,
  triggerRef,
  navigation,
  initialStatus,
  projects,
  plans,
  create,
}: CreateTicketDialogProps) {
  const recovery = useDraftRecovery();
  const [expanded, setExpanded] = useState(false);
  const [savedDraft, setDraft] = useState<Draft | null>(() => {
    const saved = recovery.read("new-ticket", draftSchema);
    return saved ? { ...saved, restored: true } : null;
  });
  const [closingDraft, setClosingDraft] = useState<Draft | null>(null);
  const [editorGeneration, setEditorGeneration] = useState(0);
  useEffect(() => {
    const payload =
      savedDraft &&
      (savedDraft.requestId || savedDraft.title || savedDraft.body)
        ? savedDraft
        : null;
    void recovery
      .put("new-ticket", payload, savedDraft?.body ? [savedDraft.body] : [])
      .catch(() => {});
  }, [savedDraft, recovery]);
  // One failure for the whole dialog, above the footer. A workspace-level
  // cause is also in the band, so this says only what it means for this ticket.
  const [error, setError] = useState<FailureDescription | null>(null);
  const workspaceBlocked = editingBlockedReason(useWorkspaceState());
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
  const [createMore, setCreateMore] = useState(savedDraft?.createMore ?? false);
  const [announcement, setAnnouncement] = useState("");
  // "Created T-FV16." stays readable in the footer for a while (list C-06).
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(""), 6000);
    return () => window.clearTimeout(timer);
  }, [announcement]);
  const titleRef = useRef<HTMLInputElement>(null);
  // The body scrolls inside a viewport-bound dialog, so a failure below the
  // fold would leave "Retry safely" unexplained: bring the notice into view.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  // Opening from a status group's Add action sets that status, even on a
  // draft kept from an earlier close.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setClosingDraft(null);
    if (open && savedDraft && initialStatus && !savedDraft.requestId)
      setDraft({ ...savedDraft, status: initialStatus });
  }
  if (open && !savedDraft)
    setDraft({
      title: "",
      body: "",
      status: initialStatus ?? "Todo",
      project:
        projects.find(
          (project) => project.id === navigation.project && !project.archived,
        )?.id ?? "",
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
  // Recovery owns savedDraft; this snapshot only keeps the exiting UI alive.
  const draft = savedDraft ?? (open ? null : closingDraft);
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
    else {
      setClosingDraft(draft);
      setDraft(null);
    }
    setConfirmNewTicket(false);
    setAnnouncement("");
    onOpenChange(false);
  }
  async function submit() {
    const currentDraft = draft!;
    if (workspaceBlocked && !currentDraft.requestId && !completedCreation)
      return;
    if (
      lock.current ||
      (!completedCreation &&
        !currentDraft.requestId &&
        !currentDraft.title.trim())
    )
      return;
    setError(null);
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
          ...(submission.blockers?.length ? [submission.blockers] : []),
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
      if (submittedCreation.createMore) {
        setEditorGeneration((value) => value + 1);
        setDraft({
          title: "",
          body: "",
          status: submission.status,
          project: submission.project,
          plan: submission.plan,
          tags: submission.tags,
          blockers: submission.blockers ?? [],
          restored: false,
        });
        setAnnouncement(`Created ${submittedCreation.reference}`);
        refocusTitle.current = true;
      } else {
        setClosingDraft(draft);
        setDraft(null);
      }
    } catch (reason) {
      if (submittedCreation) {
        const failure = describeFailure(reason, "clear the draft");
        setError({
          ...failure,
          sentence: `${submittedCreation.reference} was created. ${failure.sentence}`,
        });
      } else if (creationAttempted) {
        const failure = describeFailure(reason, "confirm the new ticket");
        if (failure.code === "project_archived") {
          setDraft({
            ...submission,
            requestId: undefined,
            followCreated: undefined,
            createMore: undefined,
          });
          setError({ ...failure, title: "Couldn't create the ticket" });
        } else {
          setError({
            ...failure,
            sentence: `${failure.sentence} Retry safely: it never creates a second ticket.`,
          });
        }
      } else {
        const failure = describeFailure(reason, "create the ticket");
        setError({
          ...failure,
          sentence: `${failure.sentence} Your draft is kept on this device.`,
        });
      }
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
    setError(null);
    try {
      recovery.retry();
      await recovery.put("new-ticket", next, next.body ? [next.body] : []);
      await recovery.flush();
      setDraft(next);
      setConfirmNewTicket(false);
      refocusTitle.current = true;
    } catch (reason) {
      const failure = describeFailure(reason, "save the edited draft");
      setError({
        ...failure,
        sentence: `${failure.sentence} The original submission can still be retried.`,
      });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  const hasSubmission = !!draft.requestId;
  const fieldsLocked = pending || hasSubmission || !!completedCreation;
  const primaryLabel = completedCreation
    ? "Finish cleanup"
    : hasSubmission
      ? "Retry safely"
      : "Create ticket";
  const blockedReason =
    !hasSubmission && !draft.title.trim()
      ? // Right after Create more, the result keeps the slot (list C-06).
        announcement
        ? `${announcement}.`
        : ""
      : pending
        ? "Creating…"
        : workspaceBlocked && !error
          ? workspaceBlocked
          : null;
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      onExitComplete={() => setClosingDraft(null)}
      title="New ticket"
      variant="create"
      expanded={expanded}
      headerActions={
        <IconButton
          type="button"
          label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
      }
      onKeyDownCapture={(event) => {
        if (
          !matchesShortcut(event.nativeEvent, "create-submit") ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        // Rich/source editors and nested choice lists own their key first.
        if (
          (event.target as HTMLElement).closest(
            ".create-description, [cmdk-root]",
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }}
      primaryLabel={primaryLabel}
      primaryHint={shortcutLabel("create-submit")}
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
      // Results and restored drafts live in the note slot, so nothing is
      // inserted into the form (list C-05, C-06).
      footerNote={
        announcement ? (
          `${announcement}.`
        ) : draft.restored ? (
          <>
            Draft restored ·{" "}
            <Button
              type="button"
              variant="link"
              size="inline"
              aria-label="Discard draft"
              disabled={fieldsLocked || hasSubmission}
              onClick={() => {
                update({ title: "", body: "", restored: false });
                setEditorGeneration((value) => value + 1);
                titleRef.current?.focus();
              }}
            >
              Discard
            </Button>
          </>
        ) : undefined
      }
      onSubmit={() => void submit()}
      returnFocus={triggerRef}
      busy={pending || !!completedCreation}
    >
      <div className="create-form flex flex-col gap-4">
        <fieldset disabled={fieldsLocked} className="contents">
          <Field data-disabled={fieldsLocked}>
            <Input
              id="create-title"
              aria-label="Title"
              variant="document-title"
              ref={titleRef}
              autoFocus
              placeholder="Ticket title"
              maxLength={TITLE_MAX_LENGTH}
              disabled={fieldsLocked}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field data-disabled={fieldsLocked}>
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
                placeholder="Markdown works here; type / for blocks."
                readOnly={fieldsLocked}
                // The quick-composer chrome: its controls are always in
                // place, so focusing the field never moves the form (C-04).
                value={draft.body}
                onChange={(body) => update({ body })}
              />
            </div>
          </Field>
          <div
            className="create-properties"
            role="group"
            aria-label="Initial properties"
          >
            <DraftPropertyPicker
              label="Status"
              display={draft.status}
              icon={<StatusIcon status={draft.status} decorative />}
              selected={draft.status}
              disabled={fieldsLocked}
              shortcut="ticket-status"
              onSelect={(status) => update({ status })}
              options={directStatuses.map((status) => ({
                value: status,
                label: status,
                icon: <StatusIcon status={status} decorative />,
              }))}
            />
            <DraftPropertyPicker
              label="Project"
              display={
                projects.find((project) => project.id === draft.project)
                  ?.name ?? "No project"
              }
              icon={<Folder />}
              selected={draft.project}
              disabled={fieldsLocked}
              shortcut="ticket-project"
              onSelect={(project) => update({ project })}
              options={[
                ...projects
                  .filter((project) => !project.archived)
                  .map((project) => ({
                    value: project.id,
                    label: project.name,
                    icon: <Folder />,
                  })),
                { value: "", label: "No project" },
              ]}
            />
            <DraftPropertyPicker
              label="Plan"
              display={
                plans.find((plan) => plan.id === draft.plan)?.name ?? "No Plan"
              }
              icon={<Layers />}
              selected={draft.plan}
              disabled={fieldsLocked}
              shortcut="ticket-plan"
              onSelect={(plan) => update({ plan })}
              options={[
                ...plans
                  .filter((plan) => !plan.archived)
                  .map((plan) => ({
                    value: plan.id,
                    label: plan.name,
                    icon: <Layers />,
                  })),
                { value: "", label: "No Plan" },
              ]}
            />
            <DraftPropertyPicker
              label="Tags"
              display={draft.tags.length ? draft.tags.join(", ") : "Tags"}
              icon={<Tags />}
              selected={draft.tags}
              disabled={fieldsLocked}
              shortcut="ticket-tags"
              options={[...new Set([...draft.tags, ...vocabulary])].map(
                (tag) => ({ value: tag, label: tag }),
              )}
              onSelect={(tag) =>
                update({
                  tags: draft.tags.includes(tag)
                    ? draft.tags.filter((value) => value !== tag)
                    : [...draft.tags, tag],
                })
              }
              onCreate={(value) => {
                const tag = value.trim().toLowerCase();
                if (tag && !draft.tags.includes(tag))
                  update({ tags: [...draft.tags, tag] });
              }}
            />
            <DraftBlockerPicker
              values={draft.blockers ?? []}
              disabled={fieldsLocked}
              onChange={(blockers) => update({ blockers })}
            />
          </div>
        </fieldset>
        {error && (
          <FailureAlert ref={errorRef} size="compact" failure={error} />
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
