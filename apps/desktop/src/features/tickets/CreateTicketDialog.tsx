import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { Layers, Folder, Tag, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { modifierKeyLabel } from "@/lib/platform";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { client, type Project } from "@/lib/api/client";
import type { Effort } from "@/lib/api/efforts";
import { directStatuses } from "./StatusIcon";
import { PropertyPicker } from "./TicketProperties";
import "./create-ticket.css";

type Draft = {
  title: string;
  body: string;
  status: string;
  project: string;
  effort: string;
  tags: string[];
  restored: boolean;
};
export function CreateTicketDialog({
  open,
  onOpenChange,
  triggerRef,
  navigation,
  projects,
  efforts,
  create,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  navigation: { project: string; effort: string };
  projects: Project[];
  efforts: Effort[];
  create: (
    title: string,
    body: string,
    status: string,
    project: string | null,
    effort: string | null,
    tags: string[],
    keepOpen: boolean,
  ) => Promise<string>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [titleError, setTitleError] = useState("");
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
  const [tagQuery, setTagQuery] = useState("");
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [createMore, setCreateMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  if (open && !draft)
    setDraft({
      title: "",
      body: "",
      status: "Todo",
      project:
        navigation.project === "all" || navigation.project === "unlinked"
          ? ""
          : navigation.project,
      effort: navigation.effort,
      tags: [],
      restored: false,
    });
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void client
        .searchTags(tagQuery)
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
  }, [open, tagQuery]);
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
  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase();
    setTagQuery("");
    if (tag && !draft!.tags.includes(tag))
      update({ tags: [...draft!.tags, tag] });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (event.target !== event.currentTarget || lock.current) return;
    if (!draft!.title.trim()) {
      setTitleError("Enter a title");
      titleRef.current?.focus();
      return;
    }
    setTitleError("");
    setError("");
    lock.current = true;
    setPending(true);
    try {
      const reference = await create(
        draft!.title,
        draft!.body,
        draft!.status,
        draft!.project || null,
        draft!.effort || null,
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
  const projectName =
    projects.find((p) => p.id === draft.project)?.name ??
    (draft.project || "Unlinked");
  const effortName =
    efforts.find((e) => e.id === draft.effort)?.name ??
    (draft.effort || "No Effort");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent
        className="create-panel"
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <div className="panel-heading">
          <DialogTitle>New ticket</DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close new ticket"
            onClick={close}
          >
            <X />
          </Button>
        </div>
        <form
          className="create-form"
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          noValidate
        >
          <FieldGroup>
            <Field data-invalid={!!titleError} data-disabled={pending}>
              <FieldLabel htmlFor="create-title">Title</FieldLabel>
              <Input
                id="create-title"
                ref={titleRef}
                autoFocus
                placeholder="e.g. Export fails on large workspaces"
                disabled={pending}
                value={draft.title}
                onChange={(event) => {
                  update({ title: event.target.value });
                  setTitleError("");
                }}
                aria-invalid={!!titleError}
                aria-describedby={titleError ? "create-title-error" : undefined}
              />
              {titleError && (
                <FieldError id="create-title-error">{titleError}</FieldError>
              )}
            </Field>
            <Field data-disabled={pending}>
              <FieldLabel asChild>
                <span>
                  Description{" "}
                  <small>Optional. Markdown and checklists work.</small>
                </span>
              </FieldLabel>
              <div
                // The editor owns its keys (Enter, slash menu, IME, Escape,
                // CodeMirror bindings), so they stop here. The one exception is
                // a Cmd/Ctrl+Enter that the rich editor left unhandled: it
                // creates the ticket. Nested UI (slash menu, link field, source
                // editors) handles or ignores it first, so it never reaches here
                // as an unhandled rich-editor event.
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
                  readOnly={pending}
                  value={draft.body}
                  onChange={(body) => update({ body })}
                />
              </div>
            </Field>
          </FieldGroup>
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
            className="create-properties"
            role="group"
            aria-label="Initial properties"
          >
            <div className="create-property">
              <span>Status</span>
              <Select
                value={draft.status}
                onValueChange={(status) => update({ status })}
                disabled={pending}
              >
                <SelectTrigger size="sm" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {directStatuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="create-property">
              <span>Project</span>
              <PropertyPicker
                label="Project"
                icon={Folder}
                value={projectName}
                disabled={pending}
                choices={[
                  { value: "", label: "Unlinked" },
                  ...projects.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChoose={(project) => update({ project })}
              />
            </div>
            <div className="create-property">
              <span>Effort</span>
              <PropertyPicker
                label="Effort"
                icon={Layers}
                value={effortName}
                disabled={pending}
                choices={[
                  { value: "", label: "No Effort" },
                  ...efforts
                    .filter((e) => !e.archived)
                    .map((e) => ({ value: e.id, label: e.name })),
                ]}
                onChoose={(effort) => update({ effort })}
              />
            </div>
            <div className="create-property create-tags">
              <span>Tags</span>
              <div className="create-tag-chips">
                {draft.tags.map((tag) => (
                  <span key={tag} className="create-tag-chip">
                    <Tag aria-hidden />
                    {tag}
                    <button
                      type="button"
                      aria-label={`Remove tag ${tag}`}
                      disabled={pending}
                      onClick={() =>
                        update({ tags: draft.tags.filter((t) => t !== tag) })
                      }
                    >
                      <X aria-hidden />
                    </button>
                  </span>
                ))}
                <Input
                  ref={tagInputRef}
                  className="create-tag-input"
                  aria-label="Add tag"
                  placeholder="Add a tag"
                  disabled={pending}
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === ",") {
                      if (event.ctrlKey || event.metaKey) return;
                      event.preventDefault();
                      addTag(tagQuery);
                    } else if (
                      event.key === "Backspace" &&
                      !tagQuery &&
                      draft.tags.length
                    )
                      update({ tags: draft.tags.slice(0, -1) });
                  }}
                />
              </div>
              {suggestions.length > 0 && (
                <ul
                  className="create-tag-suggestions"
                  aria-label="Tag suggestions"
                >
                  {suggestions.map((tag) => (
                    <li key={tag}>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          addTag(tag);
                          tagInputRef.current?.focus();
                        }}
                      >
                        {tag}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          <div className="create-actions">
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
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create ticket"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
