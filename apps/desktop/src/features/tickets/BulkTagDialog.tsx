import { useEffect, useState, type KeyboardEvent } from "react";
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
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  // Whether the list may show: after typing a non-blank query or an arrow key,
  // until Escape, a pick, or focus leaving the field.
  const [listOpen, setListOpen] = useState(false);
  // cmdk always highlights an item, so only a highlight the person moved to
  // with the arrow keys counts; Enter otherwise adds the typed text.
  const [navigated, setNavigated] = useState(false);
  const shown = listOpen && suggestions.length > 0;

  // A closed dialog keeps no list, highlight or stale suggestions for the
  // next time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setSuggestions([]);
    setUnavailable(false);
    setListOpen(false);
    setNavigated(false);
  }

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
    setNavigated(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      // cmdk highlights the first item by itself, so the first Down only has
      // to mark it as chosen; the first Up wraps to the last (see `loop`).
      // cmdk moves the highlight and scrolls it into view.
      if (!shown || !navigated) {
        setListOpen(true);
        setNavigated(true);
        if (event.key === "ArrowDown") event.preventDefault();
      }
    } else if (event.key === "Enter") {
      // cmdk prevents default on every Enter, so adding is explicit.
      if (shown && navigated) return;
      event.preventDefault();
      apply("add");
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
          setNavigated(false);
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
            {/* cmdk owns the input's id and name, so the visible label is a heading
                for the group and Command's label names the combobox. */}
            <FieldLabel>Tag name</FieldLabel>
            <Command
              label="Tag name"
              shouldFilter={false}
              loop
              className="bulk-tag-combobox"
            >
              <CommandInput
                placeholder="For example, needs-review"
                autoComplete="off"
                value={tag}
                onValueChange={(next) => {
                  setTag(next);
                  setListOpen(next.trim() !== "");
                  setNavigated(false);
                }}
                onKeyDown={onKeyDown}
                onBlur={() => {
                  setListOpen(false);
                  setNavigated(false);
                }}
              />
              <CommandList label="Existing tags" hidden={!shown}>
                {suggestions.map((suggestion) => (
                  <CommandItem
                    key={suggestion}
                    value={suggestion}
                    // Keep focus in the field while picking with the pointer.
                    onMouseDown={(event) => event.preventDefault()}
                    onSelect={() => choose(suggestion)}
                  >
                    {suggestion}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
            <p className="sr-only" role="status">
              {shown
                ? `${suggestions.length} existing ${suggestions.length === 1 ? "tag" : "tags"} suggested. Use the arrow keys to choose.`
                : ""}
            </p>
            {unavailable && (
              <p className="bulk-tag-note" role="status">
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
