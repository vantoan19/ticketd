import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SourceCounts } from "@/lib/api/client";
import type { RefreshReport } from "@/lib/api/sources";
import { providerName } from "./ticket-source";
import "./ticket-list.css";

/**
 * All, each configured provider, and Local, with counts. It narrows the status
 * groups; it never regroups the list by source.
 */
export function SourceFilter({
  value,
  onChange,
  counts,
  providers,
}: {
  value: string;
  onChange: (value: string) => void;
  counts: SourceCounts | null;
  /** Providers with a saved configuration, so the filter appears before the first import. */
  providers: string[];
}) {
  const known = [
    ...new Set([...providers, ...Object.keys(counts?.providers ?? {})]),
  ].sort();
  const choices = [
    { value: "all", label: "All", count: counts?.all },
    ...known.map((provider) => ({
      value: provider,
      label: providerName(provider),
      count: counts?.providers[provider] ?? 0,
    })),
    { value: "local", label: "Local", count: counts?.local },
  ];
  return (
    <div className="source-filter" role="group" aria-label="Ticket source">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={value === choice.value}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
          {choice.count !== undefined && (
            <span className="source-filter-count">{choice.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Manual refresh of every configured source, and what the last attempt did. */
export function SourceRefresh({
  providers,
  state,
  onRefresh,
}: {
  providers: string[];
  state: { running: boolean; report: RefreshReport | null; error: string };
  onRefresh: () => void;
}) {
  const name = providers.map(providerName).join(", ");
  const failures = state.report?.failures ?? [];
  return (
    <div className="source-refresh">
      <Button
        variant="outline"
        size="sm"
        disabled={state.running}
        onClick={onRefresh}
      >
        <RefreshCw data-icon="inline-start" />
        Refresh {name}
      </Button>
      {state.running && <span role="status">Refreshing {name}…</span>}
      {!state.running && state.report && failures.length === 0 && (
        <span role="status">
          {state.report.imported.length} new, {state.report.updated.length}{" "}
          updated
        </span>
      )}
      {!state.running && failures.length > 0 && (
        <span role="alert">
          Could not refresh {name}: {failures[0]?.message} Saved content is
          unchanged.
        </span>
      )}
      {!state.running && state.error && (
        <span role="alert">
          Could not refresh {name}: {state.error} Saved content is unchanged.
        </span>
      )}
    </div>
  );
}
