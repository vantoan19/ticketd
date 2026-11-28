import type { ComponentProps } from "react";
import { PreviewFacts } from "./PreviewFacts";

export function PreviewDetails({
  preview,
  onNavigate,
}: ComponentProps<typeof PreviewFacts>) {
  return (
    <aside className="attachment-preview-details" aria-label="Details">
      <PreviewFacts preview={preview} onNavigate={onNavigate} />
    </aside>
  );
}
