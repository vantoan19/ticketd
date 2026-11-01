import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/api/client";

/**
 * Adds or removes one tag on every selected ticket. The field is a combobox
 * that suggests existing workspace tags; picking one only fills the field, so
 * the tag is still applied by an explicit Add or Remove.
 */
export function BulkTagDialog({
  open,
  onOpenChange,
  count,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  onApply: (mode: "add" | "remove", tag: string) => void;
}) {
  const [tag, setTag] = useState("");
  const name = tag.trim();
  const listId = useId();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  // Whether the list is showing; Escape closes it before it closes the dialog.
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = listOpen && suggestions.length > 0;

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void client
        .searchTags(name)
        .then((tags) => {
          if (!current) return;
          setSuggestions(tags);
          setUnavailable(false);
          setActive(-1);
        })
        .catch(() => {
          if (!current) return;
          setSuggestions([]);
          setUnavailable(true);
        });
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [open, name]);

  function apply(mode: "add" | "remove") {
    if (!name) return;
    onApply(mode, name);
    setTag("");
    setListOpen(false);
    onOpenChange(false);
  }
  function choose(suggestion: string) {
    setTag(suggestion);
    setListOpen(false);
    setActive(-1);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setListOpen(true);
      setActive(
        shown
          ? (active + step + suggestions.length) % suggestions.length
          : step === 1
            ? 0
            : suggestions.length - 1,
      );
    } else if (event.key === "Enter" && shown && active >= 0) {
      // Picking a suggestion fills the field; a second Enter adds the tag.
      event.preventDefault();
      const picked = suggestions[active];
      if (picked) choose(picked);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        onEscapeKeyDown={(event) => {
          if (!shown) return;
          event.preventDefault();
          setListOpen(false);
          setActive(-1);
        }}
      >
        <DialogHeader>
          <DialogTitle>Add or remove tag</DialogTitle>
          <DialogDescription>
            Applies to {count} selected {count === 1 ? "ticket" : "tickets"}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="bulk-tag-form"
          onSubmit={(event) => {
            event.preventDefault();
            apply("add");
          }}
        >
          <Field>
            <FieldLabel htmlFor="bulk-tag-name">Tag name</FieldLabel>
            <Input
              id="bulk-tag-name"
              placeholder="For example, needs-review"
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={shown}
              aria-controls={listId}
              aria-activedescendant={
                shown && active >= 0 ? `${listId}-${active}` : undefined
              }
              value={tag}
              onChange={(event) => {
                setTag(event.target.value);
                setListOpen(true);
              }}
              onKeyDown={onKeyDown}
            />
            <ul
              id={listId}
              role="listbox"
              aria-label="Existing tags"
              className="bulk-tag-suggestions"
              hidden={!shown}
            >
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  // Keep focus in the field while picking with the pointer.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(suggestion)}
                >
                  {suggestion}
                </li>
              ))}
            </ul>
            <p className="sr-only" role="status">
              {shown
                ? `${suggestions.length} existing ${suggestions.length === 1 ? "tag" : "tags"} suggested. Use the arrow keys to choose.`
                : ""}
            </p>
            {unavailable && (
              <p className="bulk-tag-note">
                Tag suggestions unavailable. You can still enter a tag.
              </p>
            )}
          </Field>
          {/* Removing sits at the far end from the submit button, which adds. */}
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={!name}
              onClick={() => apply("remove")}
            >
              Remove tag
            </Button>
            <Button type="submit" disabled={!name}>
              Add tag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
