import { useEffect, useState } from "react";
import { Tag } from "lucide-react";
import { ChoiceList } from "@/components/ui/choice-list";
import { DialogShell } from "@/components/ui/dialog-shell";
import { client } from "@/lib/api/client";

/**
 * Adds or removes one tag on every selected ticket (DESIGN.md section 11).
 * The body is a tag choice list: existing workspace tags as rows, and when
 * adding, "Create “x”" for a new one. Choosing only marks the tag; the
 * footer's primary applies it.
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
  mode: "add" | "remove";
  onApply: (mode: "add" | "remove", tag: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  // A closed dialog keeps no query, choice or stale suggestions for the next
  // time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setQuery("");
    setChosen("");
    setSuggestions([]);
    setUnavailable(false);
  }

  const name = query.trim();
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

  const verb = mode === "add" ? "Add tag" : "Remove tag";
  const tickets = `${count} selected ${count === 1 ? "ticket" : "tickets"}`;
  const icon = <Tag aria-hidden="true" />;
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={verb}
      description={`Applies to ${tickets}.`}
      primaryLabel={verb}
      blockedReason={
        chosen
          ? null
          : mode === "add"
            ? "Choose or create a tag."
            : "Choose a tag."
      }
      footerNote={
        chosen &&
        (mode === "add"
          ? `Adds “${chosen}” to ${count === 1 ? "1 ticket" : `${count} tickets`}.`
          : `Removes “${chosen}” from ${count === 1 ? "1 ticket" : `${count} tickets`}.`)
      }
      onSubmit={() => {
        if (!chosen) return;
        onApply(mode, chosen);
        onOpenChange(false);
      }}
    >
      <div className="bulk-tag-choices">
        <ChoiceList
          label="Tags"
          searchPlaceholder="Search tags"
          query={query}
          onQueryChange={setQuery}
          groups={[
            ...suggestions,
            // A tag may be removed by name even when suggestions miss it.
            ...(mode === "remove" && name && !suggestions.includes(name)
              ? [name]
              : []),
          ].map((tag) => ({ value: tag, label: tag, icon }))}
          selected={chosen}
          onSelect={setChosen}
          {...(mode === "add" && { create: setChosen })}
          {...(unavailable && {
            notice:
              mode === "add"
                ? "Tag suggestions unavailable. You can still create a tag."
                : "Tag suggestions unavailable.",
          })}
          empty={(text) => (text ? `No tags match “${text}”` : "No tags yet")}
        />
      </div>
    </DialogShell>
  );
}
