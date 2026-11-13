import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Bell, Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  TEXT_FIELDS,
  textInWords,
  textParts,
  type TextField,
} from "@/features/automations/automation-text";
import {
  automationsClient,
  type StepChange,
} from "@/features/automations/client";
import { directStatuses } from "@/lib/statuses";

function chipFor(field: TextField): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "flow-field";
  chip.contentEditable = "false";
  chip.dataset.field = field;
  chip.textContent = TEXT_FIELDS[field];
  return chip;
}

/** The text to store for what the box shows: each chip as its reference. */
function stored(node: Node): string {
  return [...node.childNodes]
    .map((child) => {
      if (!(child instanceof HTMLElement)) return child.textContent ?? "";
      if (child.dataset.field) return `{{${child.dataset.field}}}`;
      if (child.tagName === "BR") return "\n";
      // A browser may wrap a typed line in a block of its own.
      return (child.previousSibling ? "\n" : "") + stored(child);
    })
    .join("");
}

/**
 * Text that can hold ticket fields. A field shows as a named chip and is stored
 * as a plain reference. The box keeps its own content while it is edited, so the
 * caret never jumps: mount it with a `key` to show different text.
 */
function FieldText({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** Where the caret last was in the box: a menu takes the selection away. */
  const caret = useRef<Range | null>(null);
  const [initial] = useState(value);
  useLayoutEffect(() => {
    box.current?.replaceChildren(
      ...textParts(initial).map((part) =>
        typeof part === "string" ? part : chipFor(part.field),
      ),
    );
  }, [initial]);
  useEffect(() => {
    const keep = () => {
      const selection = document.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && box.current?.contains(range.commonAncestorContainer))
        caret.current = range.cloneRange();
    };
    document.addEventListener("selectionchange", keep);
    return () => document.removeEventListener("selectionchange", keep);
  }, []);

  const insert = (field: TextField) => {
    const element = box.current;
    if (!element) return;
    const chip = chipFor(field);
    const at = caret.current;
    if (at && element.contains(at.commonAncestorContainer)) {
      at.deleteContents();
      at.insertNode(chip);
    } else element.append(chip);
    const after = document.createRange();
    after.setStartAfter(chip);
    after.collapse(true);
    caret.current = after;
    onChange(stored(element));
  };
  return (
    <>
      <div
        ref={box}
        className="flow-text"
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        tabIndex={0}
        // Typed and pasted text stays text: no markup comes in with it.
        contentEditable="plaintext-only"
        onInput={(event) => onChange(stored(event.currentTarget))}
      />
      <div className="flow-text-bar">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs">
              <Braces aria-hidden />
              Insert field
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label="Insert field"
            // Back to the text, after the field that was inserted.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              box.current?.focus();
              const selection = document.getSelection();
              if (!selection || !caret.current) return;
              selection.removeAllRanges();
              selection.addRange(caret.current);
            }}
          >
            {(Object.keys(TEXT_FIELDS) as TextField[]).map((field) => (
              <DropdownMenuItem key={field} onSelect={() => insert(field)}>
                {TEXT_FIELDS[field]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

const CHANGES = [
  { value: "add_tag", label: "Add a tag" },
  { value: "remove_tag", label: "Remove a tag" },
  { value: "set_status", label: "Set the status" },
  { value: "post_update", label: "Post an update" },
] as const satisfies { value: StepChange["action"]; label: string }[];
const STATUSES = directStatuses.map((status) => ({
  value: status,
  label: status,
}));

export function ChangeTicketFields({
  change,
  automationName,
  onChange,
}: {
  change: StepChange;
  automationName: string;
  onChange: (change: StepChange) => void;
}) {
  const id = useId();
  const choose = (action: StepChange["action"]) => {
    if (action === change.action) return;
    if (action === "set_status") onChange({ action, status: "Done" });
    else if (action === "post_update") onChange({ action, text: "" });
    // Add and remove keep the tag when one becomes the other.
    else onChange({ action, tag: "tag" in change ? change.tag : "" });
  };
  return (
    <>
      <div className="flow-panel-section">
        <Picker
          stacked
          label="Change"
          value={change.action}
          onValueChange={choose}
          options={[...CHANGES]}
        />
      </div>
      {(change.action === "add_tag" || change.action === "remove_tag") && (
        <div className="flow-panel-section">
          <label htmlFor={id}>Tag</label>
          <Input
            id={id}
            placeholder="e.g. needs-fix"
            value={change.tag}
            // Tags are stored in lower case; show the tag as it will be.
            onChange={(event) =>
              onChange({ ...change, tag: event.target.value.toLowerCase() })
            }
          />
        </div>
      )}
      {change.action === "set_status" && (
        <div className="flow-panel-section">
          <Picker
            stacked
            label="Status"
            value={change.status}
            onValueChange={(status) => onChange({ ...change, status })}
            options={STATUSES}
          />
        </div>
      )}
      {change.action === "post_update" && (
        <div className="flow-panel-section">
          <span aria-hidden="true">Update</span>
          <FieldText
            label="Update"
            value={change.text}
            onChange={(text) => onChange({ ...change, text })}
          />
          <p className="flow-panel-note">
            Posted as {automationName}, so you can tell it from your own
            updates.
          </p>
        </div>
      )}
    </>
  );
}

export function NotifyFields({
  text,
  opens,
  automationName,
  eventTag,
  onChange,
}: {
  text: string;
  opens: "ticket" | "run";
  automationName: string;
  /** The tag the trigger names, which stands for the event's tag in the preview. */
  eventTag: string | null;
  onChange: (patch: { text?: string; opens?: "ticket" | "run" }) => void;
}) {
  const previewId = useId();
  /** undefined until the core answers; null while there is no ticket. */
  const [preview, setPreview] = useState<string | null>();
  useEffect(() => {
    let current = true;
    automationsClient.previewText(text, eventTag).then(
      (filled) => current && setPreview(filled),
      // The preview is a convenience; the message itself is unaffected.
      () => current && setPreview(null),
    );
    return () => {
      current = false;
    };
  }, [text, eventTag]);
  return (
    <>
      <div className="flow-panel-section">
        <span aria-hidden="true">Message</span>
        <FieldText
          label="Message"
          value={text}
          onChange={(next) => onChange({ text: next })}
        />
      </div>
      <div className="flow-panel-section">
        <span aria-hidden="true">Opens</span>
        <div>
          <SegmentedControl
            aria-label="Opens"
            value={opens}
            onValueChange={(next) => onChange({ opens: next })}
            options={[
              { value: "ticket", label: "The ticket" },
              { value: "run", label: "The run" },
            ]}
          />
        </div>
      </div>
      <div
        className="flow-panel-section"
        role="group"
        aria-labelledby={previewId}
      >
        <span id={previewId}>Preview</span>
        <div className="notify-preview">
          <span className="notify-preview-app">
            <Bell size={14} aria-hidden />
            ticketd
          </span>
          <strong>{automationName}</strong>
          <span>{preview ?? textInWords(text)}</span>
        </div>
        <p className="flow-panel-note">
          {preview === null
            ? "No ticket to preview it with yet."
            : "With the most recent ticket."}
        </p>
      </div>
    </>
  );
}
