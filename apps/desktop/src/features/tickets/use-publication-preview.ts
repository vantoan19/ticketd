import { useEffect, useState } from "react";
import type { Ticket } from "@/lib/api/client";
import { sourcesClient, type PublicationPreview } from "@/lib/api/sources";
import { useSources } from "@/features/settings/sources/use-sources";

/**
 * The source a local ticket can be published to: the first connector that
 * declares the publish capability, and when it was last saved, so connecting it in
 * Settings makes the answer change.
 */
export function usePublishTarget(): { provider: string; saved: string } | null {
  const { entries } = useSources();
  const entry = entries.find((item) =>
    item.connector.capabilities.includes("publish"),
  );
  return entry
    ? {
        provider: entry.connector.provider,
        saved: entry.saved?.saved_at ?? "",
      }
    : null;
}

/**
 * Whether and how a local ticket can be published, read from the core. It reads
 * again whenever what decides the answer changes (the ticket's title, description,
 * status, trash or attempt, or the source being saved). Failure to read leaves the
 * rail without a Publish action rather than guessing.
 */
export function usePublicationPreview(
  ticket: Ticket | undefined,
  target: { provider: string; saved: string } | null,
): PublicationPreview | null {
  const [result, setResult] = useState<{
    basis: string;
    preview: PublicationPreview;
  } | null>(null);
  const reference = ticket?.reference;
  const basis = JSON.stringify([
    ticket?.reference,
    ticket?.title,
    ticket?.body,
    ticket?.status,
    ticket?.trashed,
    ticket?.publication?.state,
    target?.provider,
    target?.saved,
  ]);
  const provider = target?.provider;

  useEffect(() => {
    if (!provider || !reference) return;
    let active = true;
    sourcesClient.previewPublication(reference, provider).then(
      (found) => {
        if (active) setResult({ basis, preview: found });
      },
      () => {
        if (active) setResult(null);
      },
    );
    return () => {
      active = false;
    };
  }, [provider, reference, basis]);
  return provider && result?.basis === basis ? result.preview : null;
}

/** Desktop wording of the core's eligibility reason; no eligibility decisions here. */
export function publicationReason(preview: PublicationPreview): string {
  if (preview.eligibility.kind === "eligible") return "";
  switch (preview.eligibility.reason) {
    case "status":
      return "Only Todo, In progress and In review tickets can be published.";
    case "source_not_connected":
      return "Connect GitHub in Settings to publish.";
    case "trashed":
      return "Restore this ticket from the trash to publish it.";
    case "externally_owned":
      return "This ticket already belongs to GitHub.";
    case "provenance_retained":
      return "This ticket keeps its previous GitHub identity and cannot be published again.";
    case "attempt_open":
      return "Settle the previous publication outcome before publishing again.";
    case "unsupported":
      return "This source does not support publication.";
    case "internal_attachments":
      return preview.eligibility.message;
  }
}
