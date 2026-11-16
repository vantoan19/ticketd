"use client";

import { searchMatch } from "@/lib/search-match";

import * as React from "react";
import { Command as CommandPrimitive, useCommandState } from "cmdk";
import { cn } from "cn";
import { SearchIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function Command({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive> & {
  variant?: "default" | "palette";
}) {
  return (
    <CommandPrimitive
      data-slot="command"
      data-variant={variant}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md",
        className,
      )}
      {...props}
    >
      {children}
      <CommandActiveOption />
    </CommandPrimitive>
  );
}

/** cmdk 1.1.1 can publish its selected id before React commits the selected row.
 * Resolve the committed option for assistive technology, including on first open. */
function CommandActiveOption() {
  const value = useCommandState((state) => state.value);
  const marker = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const root = marker.current?.closest("[cmdk-root]");
    const input = root?.querySelector("[cmdk-input]");
    const selected = root?.querySelector('[cmdk-item][aria-selected="true"]');
    if (selected?.id) input?.setAttribute("aria-activedescendant", selected.id);
    else input?.removeAttribute("aria-activedescendant");
  }, [value]);
  return <span ref={marker} hidden />;
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  escapeHint = false,
  scope,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  escapeHint?: boolean;
  scope?: React.ReactNode;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      {!scope && <SearchIcon className="size-4 shrink-0 opacity-50" />}
      {scope}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-(--disabled-foreground) disabled:cursor-not-allowed disabled:text-(--disabled-foreground)",
          className,
        )}
        {...props}
      />
      {escapeHint && <Kbd aria-hidden="true">esc</Kbd>}
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    // A quiet row in the list's own grid, not a centred block (P3).
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="flex min-h-8 items-center px-2 py-1.5 text-sm text-muted-foreground"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

/**
 * One row of a choice list or picker (P3): 32px, or 36px with `size="tall"`
 * for ticket and record pickers. A disabled row keeps a readable
 * `--disabled-foreground` label and no opacity. Prefer ChoiceList, which
 * lays out the icon, label, meta and the trailing check.
 */
function CommandItem({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
  size?: "default" | "tall";
}) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      data-size={size}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:text-(--disabled-foreground) data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The same ordered-letter match drives filtering and visible emphasis. */
function CommandMatch({ text, query }: { text: string; query: string }) {
  const indices = new Set(searchMatch(text, query) ?? []);
  const parts: { text: string; match: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const match = indices.has(index);
    const last = parts.at(-1);
    if (last && last.match === match) last.text += text[index];
    else parts.push({ text: text[index]!, match });
  }
  return parts.map((part, index) =>
    part.match ? (
      <mark className="ui-command-match" key={index}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandMatch,
  CommandSeparator,
};
