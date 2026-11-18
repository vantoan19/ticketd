import { useEffect, useState } from "react";
import type { Ticket } from "@/lib/api/client";
import { sourcesClient, type PublicationPreview } from "@/lib/api/sources";
import { useSources } from "@/features/settings/sources/use-sources";

/**
 * Whether any external source is set up in this workspace. Until one is,
 * every ticket is local and nothing says so: no "Local", no Source section,
 * no publishing (DESIGN.md section 7).
 */
export function useSourcesConfigured(): boolean {
  return useSources().entries.some((entry) => entry.saved !== null);
}

/**
 * The source a local ticket can be published to: the first connector that
 * declares the publish capability and has a saved configuration, and when it
 * was saved, so changing it in Settings makes the answer change. A connector
 * that is not set up offers nothing to publish to.
 */
export function usePublishTarget(): { provider: string; saved: string } | null {
  const { entries } = useSources();
  const entry = entries.find(
    (item) =>
      item.saved !== null && item.connector.capabilities.includes("publish"),
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
 * status, trash or attempt, or the source being saved). While it reads again the
 * last answer for the same ticket stays, so the rail's Publish action never
 * blinks after an edit. Failure to read leaves the rail without a Publish action
 * rather than guessing.
 */
export function usePublicationPreview(
  ticket: Ticket | undefined,
  target: { provider: string; saved: string } | null,
): PublicationPreview | null {
  const [result, setResult] = useState<{
    reference: string;
    provider: string;
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
        if (active) setResult({ reference, provider, preview: found });
      },
      () => {
        if (active) setResult(null);
      },
    );
    return () => {
      active = false;
    };
  }, [provider, reference, basis]);
  if (!provider || !result) return null;
  return result.reference === reference && result.provider === provider
    ? result.preview
    : null;
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
    case "invalid_destination":
      return preview.eligibility.message;
  }
}
