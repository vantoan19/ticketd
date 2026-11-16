import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** A reserved header control reports the failure before it is safe to move the pane. */
export function WorkspaceNotice({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          label={label}
          size="icon-compact"
          variant="attention"
          data-workspace-notice=""
        >
          <TriangleAlert aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Workspace notice"
        variant="workspace"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
