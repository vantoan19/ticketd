import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function BulkAction({
  label,
  disabled,
  open,
  onOpenChange,
  error,
  children,
}: {
  label: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error: string;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Change selected ${label.toLowerCase()}`}
        >
          {label}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="bulk-action-popover"
        aria-label={`Bulk ${label.toLowerCase()}`}
      >
        <FieldGroup>
          {error && (
            <p className="bulk-action-error" role="alert">
              {error}
            </p>
          )}
          <Field>{children}</Field>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}
