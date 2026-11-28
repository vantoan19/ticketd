import { StatusDot } from "@/components/ui/status-dot";

export function NewUpdateDot() {
  return (
    <span role="img" aria-label="New">
      <StatusDot tone="unread" size={6} />
    </span>
  );
}
