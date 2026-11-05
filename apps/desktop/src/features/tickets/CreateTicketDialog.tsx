import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { modifierKeyLabel } from "@/lib/platform";
import { Picker } from "@/components/ui/picker";
import { Switch } from "@/components/ui/switch";
import { TokenField } from "@/components/ui/token-field";
import { client, type Project } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { directStatuses } from "@/lib/statuses";
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
};
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
  ) => Promise<string>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
  const [createMore, setCreateMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  // Opening from a status group's Add action sets that status, even on a
  // draft kept from an earlier close.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && draft && initialStatus)
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
    const dirty = !!(draft!.title.trim() || draft!.body.trim());
    if (dirty) update({ restored: true });
    else setDraft(null);
    setAnnouncement("");
    onOpenChange(false);
  }
  async function submit() {
    if (lock.current || !draft!.title.trim()) return;
    setError("");
    lock.current = true;
    setPending(true);
    try {
      const reference = await create(
        draft!.title,
        draft!.body,
        draft!.status,
        draft!.project || null,
        draft!.plan || null,
        draft!.tags,
        createMore,
      );
      if (createMore) {
        update({ title: "", body: "", restored: false });
        setAnnouncement(`Created ${reference}`);
        refocusTitle.current = true;
      } else setDraft(null);
    } catch (reason) {
      setError(`Could not create ticket: ${String(reason)}`);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  const suggestions = vocabulary
    .filter((tag) => !draft.tags.includes(tag))
    .slice(0, 6);
  const blockedReason = !draft.title.trim()
    ? "Add a title to create"
    : pending
      ? "Creating…"
      : null;
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="New ticket"
      primaryLabel="Create ticket"
      blockedReason={blockedReason}
      onSubmit={() => void submit()}
      returnFocus={triggerRef}
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
        <Field data-disabled={pending}>
          <FieldLabel htmlFor="create-title">Title</FieldLabel>
          <Input
            id="create-title"
            ref={titleRef}
            autoFocus
            placeholder="e.g. Export fails on large workspaces"
            disabled={pending}
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel asChild>
            <span>
              Description <small>Optional. Markdown and checklists work.</small>
            </span>
          </FieldLabel>
          <div
            // The editor owns its keys (Enter, slash menu, IME, Escape,
            // CodeMirror bindings), so they stop here. The one exception is
            // a Cmd/Ctrl+Enter that the rich editor left unhandled: it
            // creates the ticket. Nested UI (slash menu, link field, source
            // editors) handles or ignores it first, so it never reaches here
            // as an unhandled rich-editor event.
            // The area keeps its height while the editor loads.
            className="min-h-32"
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
              label="Description"
              placeholder="Steps, acceptance criteria, or a checklist"
              readOnly={pending}
              value={draft.body}
              onChange={(body) => update({ body })}
            />
          </div>
          <small className="create-description-hint">
            Markdown works · type / for blocks
          </small>
        </Field>
        {draft.restored && (
          <p className="create-restored" role="status">
            Draft restored.{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                update({ title: "", body: "", restored: false });
                titleRef.current?.focus();
              }}
            >
              Discard draft
            </Button>
          </p>
        )}
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Initial properties"
        >
          <Picker
            label="Status"
            value={draft.status}
            disabled={pending}
            onValueChange={(status) => update({ status })}
            options={directStatuses.map((status) => ({
              value: status,
              label: status,
            }))}
          />
          <Picker
            label="Project"
            value={draft.project || NONE}
            disabled={pending}
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
            value={draft.plan || NONE}
            disabled={pending}
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
        <div className="flex flex-col gap-1.5">
          <TokenField
            label="Add tag"
            placeholder="Add a tag"
            suggestions={suggestions}
            values={draft.tags}
            onChange={(tags) =>
              update({ tags: tags.map((tag) => tag.toLowerCase()) })
            }
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <div className="flex items-center gap-4">
          <label className="create-more">
            <Switch
              checked={createMore}
              onCheckedChange={setCreateMore}
              disabled={pending}
              aria-label="Create more"
            />
            <span>Create more</span>
          </label>
          <small className="create-hint">
            <Kbd>{modifierKeyLabel()}</Kbd>
            <Kbd>Enter</Kbd> to create
          </small>
        </div>
      </div>
    </DialogShell>
  );
}
