import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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

// A cmdk value that matches no suggestion, so nothing is highlighted.
const NONE = "\u0000";

/**
 * Adds or removes one tag on every selected ticket. The field is a combobox
 * that suggests existing workspace tags; picking one only fills the field, so
 * the tag is still applied by an explicit Add or Remove.
 */
export function BulkTagDialog({
  open,
  onOpenChange,
  count,
  mode,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  /** One action only; left out, both Add tag and Remove tag are offered. */
  mode?: "add" | "remove";
  onApply: (mode: "add" | "remove", tag: string) => void;
}) {
  const [tag, setTag] = useState("");
  const name = tag.trim();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  // Whether the list may show: after typing a non-blank query or an arrow key,
  // until Escape, a pick, or focus leaving the field.
  const [listOpen, setListOpen] = useState(false);
  // The highlighted suggestion, or "" for none. cmdk highlights the first
  // match by itself, so Command's value is controlled and only a move the
  // person makes (arrow keys, pointer) is kept; that is what Enter picks.
  const [highlight, setHighlight] = useState("");
  // cmdk keeps its own highlight and only follows `value` when the prop
  // changes, so each time it highlights by itself the placeholder changes to
  // pull it back.
  const [reset, setReset] = useState(0);
  const moving = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = listOpen && suggestions.length > 0;

  // A closed dialog keeps no list, highlight or stale suggestions for the
  // next time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setSuggestions([]);
    setUnavailable(false);
    setListOpen(false);
    setHighlight("");
  }

  // cmdk always renders aria-expanded="true"; say when the list is hidden.
  // Runs every render because the dialog portal mounts after the first one.
  useEffect(() => {
    inputRef.current?.setAttribute("aria-expanded", String(shown));
  });

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
    setHighlight("");
  }
  // cmdk reports the person's move synchronously inside the same event, so
  // the flag only has to outlive that dispatch.
  function expectMove() {
    moving.current = true;
    queueMicrotask(() => {
      moving.current = false;
    });
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      setListOpen(true);
      expectMove();
    } else if (event.key === "Home" || event.key === "End") {
      // Keep them as text-caret keys; cmdk would jump through the list.
      event.stopPropagation();
    } else if (event.key === "Enter") {
      // cmdk prevents default on every Enter, so adding is explicit.
      if (shown && suggestions.includes(highlight)) return;
      event.preventDefault();
      apply(mode ?? "add");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        onEscapeKeyDown={(event) => {
          // Escape cancels an IME composition, not the dialog.
          if (event.isComposing) {
            event.preventDefault();
            return;
          }
          if (!shown) return;
          event.preventDefault();
          setListOpen(false);
          setHighlight("");
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "add"
              ? "Add tag"
              : mode === "remove"
                ? "Remove tag"
                : "Add or remove tags"}
          </DialogTitle>
          <DialogDescription>
            Applies to {count} selected {count === 1 ? "ticket" : "tickets"}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="bulk-tag-form"
          onSubmit={(event) => {
            event.preventDefault();
            apply(mode ?? "add");
          }}
        >
          <Field>
            {/* cmdk sets the input's id and aria-labelledby itself, so htmlFor
                cannot link this label; Command's label names the combobox and
                a click here focuses the field. */}
            <FieldLabel aria-hidden onClick={() => inputRef.current?.focus()}>
              Tag name
            </FieldLabel>
            <Command
              label="Tag name"
              shouldFilter={false}
              vimBindings={false}
              loop
              value={highlight || NONE + reset}
              onValueChange={(next) => {
                if (moving.current) setHighlight(next);
                else if (!next.startsWith(NONE)) setReset((n) => n + 1);
              }}
              className="bulk-tag-combobox"
              // Keep focus in the field for any press that is not on the
              // field itself: options, the scrollbar, the search icon.
              onMouseDown={(event) => {
                if (event.target !== inputRef.current) event.preventDefault();
              }}
            >
              <CommandInput
                ref={inputRef}
                placeholder="For example, needs-review"
                autoComplete="off"
                value={tag}
                onValueChange={(next) => {
                  moving.current = false;
                  setTag(next);
                  setListOpen(next.trim() !== "");
                  setHighlight("");
                }}
                onKeyDown={onKeyDown}
                onBlur={() => {
                  setListOpen(false);
                  setHighlight("");
                }}
              />
              <CommandList
                label="Existing tags"
                hidden={!shown}
                onPointerMoveCapture={expectMove}
              >
                {suggestions.map((suggestion) => (
                  <CommandItem
                    key={suggestion}
                    value={suggestion}
                    onSelect={() => choose(suggestion)}
                  >
                    {suggestion}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
            <p
              role="status"
              className={unavailable ? "bulk-tag-note" : "sr-only"}
            >
              {unavailable
                ? "Tag suggestions unavailable. You can still enter a tag."
                : shown
                  ? `${suggestions.length} existing ${suggestions.length === 1 ? "tag" : "tags"} suggested. Use the arrow keys to choose.`
                  : ""}
            </p>
          </Field>
          {/* Removing sits at the far end from the submit button, which adds. */}
          <DialogFooter className={mode ? undefined : "sm:justify-between"}>
            {mode !== "add" && (
              <Button
                type={mode === "remove" ? "submit" : "button"}
                variant={mode === "remove" ? "default" : "outline"}
                disabled={!name}
                onClick={mode === "remove" ? undefined : () => apply("remove")}
              >
                Remove tag
              </Button>
            )}
            {mode !== "remove" && (
              <Button type="submit" disabled={!name}>
                Add tag
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
