import { useContext, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { RailPlacement } from "./rail-placement";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * One file or Document in the rail (P12 RecordRow at rail density): the
 * whole row opens it; line 1 is the 16px icon and the name on one line
 * (the full name in a tooltip when cut), line 2 a muted caption ("PDF ·
 * 590 B · On this computer", "Linked"). Its one action sits in a reserved
 * trailing slot, revealed on hover and focus, always visible on touch.
 */
export function FileRow({
  icon,
  name,
  caption,
  onOpen,
  action,
}: {
  icon: ReactNode;
  name: string;
  caption: ReactNode;
  onOpen: () => void;
  action?: ReactNode;
}) {
  const placement = useContext(RailPlacement);
  const open = (
    <button
      type="button"
      className="rail-file-open"
      aria-label={name}
      onClick={onOpen}
    >
      {icon}
      <Tooltip content={name} overflowOnly>
        <span className="rail-file-name">{name}</span>
      </Tooltip>
      <small className="rail-file-caption">{caption}</small>
    </button>
  );
  return (
    <li className="rail-file" data-action={action ? "" : undefined}>
      {placement === "column" ? (
        <Card asChild variant="file">
          {open}
        </Card>
      ) : (
        open
      )}
      {action && <span className="rail-file-action">{action}</span>}
    </li>
  );
}
