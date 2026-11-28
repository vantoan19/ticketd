import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status-label";
import { SourceLink } from "@/features/tickets/SourceLink";
import type { DiscoveryPreview } from "@/lib/api/sources";
import "./sources.css";

export function SourcePreview({
  preview,
  discoveryNote,
  refresh,
  busy,
}: {
  preview: DiscoveryPreview;
  discoveryNote: string | null | undefined;
  refresh: () => void;
  busy: boolean;
}) {
  return (
    <div className="source-preview" role="region" aria-label="Preview">
      <div className="source-preview-heading">
        <div className="source-preview-title">
          <h3>
            Preview · {preview.complete ? "" : "at least "}
            {preview.matched}{" "}
            {preview.matched === 1 ? "issue matches" : "issues match"}
          </h3>
          <p>
            {preview.new !== undefined && (
              <>
                <span>
                  {preview.new} new · {preview.already_here} already here
                </span>
                {" · "}
              </>
            )}
            {preview.matched === 0
              ? "No open issues match these rules. You can still save them."
              : `Checked as ${preview.account}; nothing has been imported.`}
            {discoveryNote && ` ${discoveryNote}`}
            {preview.issues.length < preview.matched &&
              ` Showing the first ${preview.issues.length}.`}
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>
          Refresh preview
        </Button>
      </div>
      {preview.issues.length > 0 && (
        <div className="source-table-scroll">
          <table className="source-table">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">Title</th>
                <th scope="col">In ticketd</th>
              </tr>
            </thead>
            <tbody>
              {preview.issues.map((issue) => (
                <tr key={issue.display}>
                  <td>
                    <SourceLink url={issue.url} className="source-preview-ref">
                      {issue.label ?? issue.display}
                    </SourceLink>
                  </td>
                  <td>{issue.title}</td>
                  <td>
                    {issue.ticket ? (
                      <StatusLabel tone="positive" size="caption">
                        Already{" "}
                        <span className="source-number">{issue.ticket}</span>
                      </StatusLabel>
                    ) : (
                      <StatusLabel tone="neutral" size="caption">
                        New · Todo
                      </StatusLabel>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
