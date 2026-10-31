import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Adds or removes one tag on every selected ticket. */
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
  function apply(mode: "add" | "remove") {
    if (!name) return;
    onApply(mode, name);
    setTag("");
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
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
          <Input
            aria-label="Tag name"
            placeholder="Tag name"
            autoComplete="off"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          />
          <DialogFooter>
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
