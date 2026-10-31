import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { PropertyPicker } from "./TicketProperties";

type Draft = {
  title: string;
  body: string;
  status: string;
  project: string;
  effort: string;
  tags: string[];
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
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [titleError, setTitleError] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [tagQuery, setTagQuery] = useState("");
  const [vocabulary, setVocabulary] = useState<string[]>([]);
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    if (!draft!.title.trim()) {
      setTitleError("Enter a title.");
      return;
    }
    setTitleError("");
    setError("");
    lock.current = true;
    setPending(true);
    try {
      await create(
        draft!.title,
        draft!.body,
        draft!.status,
        draft!.project || null,
        draft!.effort || null,
        draft!.tags,
      );
      setDraft(null);
    } catch (reason) {
      setError(`Could not create ticket: ${String(reason)}`);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  const projectName =
    projects.find((p) => p.id === draft.project)?.name ??
    (draft.project || "Unlinked");
  const effortName =
    efforts.find((e) => e.id === draft.effort)?.name ??
    (draft.effort || "No Effort");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            onClick={() => onOpenChange(false)}
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
              <FieldLabel htmlFor="create-title">New ticket title</FieldLabel>
              <Input
                id="create-title"
                autoFocus
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
              <FieldLabel htmlFor="create-body">Description</FieldLabel>
              <Textarea
                id="create-body"
                disabled={pending}
                rows={4}
                value={draft.body}
                onChange={(event) => update({ body: event.target.value })}
              />
            </Field>
          </FieldGroup>
          <div className="ticket-properties" aria-label="Initial properties">
            <div className="ticket-property">
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
                    {[
                      "Todo",
                      "In progress",
                      "In review",
                      "Done",
                      "Canceled",
                    ].map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="ticket-property">
              <span>Project</span>
              <PropertyPicker
                label="Project"
                value={projectName}
                disabled={pending}
                choices={[
                  { value: "", label: "Unlinked" },
                  ...projects.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChoose={(project) => update({ project })}
              />
            </div>
            <div className="ticket-property">
              <span>Effort</span>
              <PropertyPicker
                label="Effort"
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
            <div className="ticket-property">
              <span>Tags</span>
              <PropertyPicker
                label="Tags"
                value={draft.tags.length ? draft.tags.join(", ") : "No tags"}
                disabled={pending}
                allowCreate
                onSearch={setTagQuery}
                choices={[...new Set([...vocabulary, ...draft.tags])].map(
                  (tag) => ({
                    value: tag,
                    label: draft.tags.includes(tag) ? `✓ ${tag}` : tag,
                  }),
                )}
                onChoose={(tag) =>
                  update({
                    tags: draft.tags.includes(tag)
                      ? draft.tags.filter((t) => t !== tag)
                      : [...draft.tags, tag],
                  })
                }
              />
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="create-actions">
            <small>Ctrl/⌘ + Enter to create</small>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create ticket"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
