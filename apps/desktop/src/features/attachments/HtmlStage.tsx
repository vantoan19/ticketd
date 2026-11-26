import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { prepareReport, type PreparedReport } from "./html-report";
import { PreviewState } from "./PreviewState";

type Loaded =
  | { key: string; report: PreparedReport }
  | { key: string; failure: FailureDescription };

/**
 * A stored HTML report, read-only. It renders in a sandboxed frame with no
 * scripts, no network and no access to the app (opaque origin), fed from one
 * bounded read of the stored snapshot; see `html-report.ts` for the rest.
 */
export function HtmlStage({
  workspace,
  file,
  attempt,
  onRetry,
}: {
  workspace: string;
  file: Attachment;
  /** Bumped by Retry: the report is read again. */
  attempt: number;
  onRetry: () => void;
}) {
  const key = `${workspace}/${file.id}/${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    attachments.html(workspace, file.id).then(
      (source) => {
        if (active) setLoaded({ key, report: prepareReport(source) });
      },
      (reason: unknown) => {
        if (active)
          setLoaded({
            key,
            failure: describeFailure(reason, "read the report"),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [key, workspace, file.id]);
  const current = loaded?.key === key ? loaded : null;
  if (!current)
    return (
      <div
        role="status"
        aria-label="Loading preview"
        className="attachment-preview-loading"
      >
        <Skeleton className="h-full w-full" />
      </div>
    );
  if ("failure" in current)
    return <FailureState failure={current.failure} onRetry={onRetry} />;
  const { report } = current;
  if (report.unusable)
    return (
      <PreviewState
        family="text"
        title="This report can't show here"
        sentence="It needs scripts or files that aren't part of the attachment. Open it in your browser."
      />
    );
  return (
    <div className="attachment-report">
      {(report.scripts || report.external) && (
        <p className="attachment-report-note">
          <Info aria-hidden="true" />
          Scripts and online images are off in this preview.
        </p>
      )}
      <iframe
        className="attachment-report-frame"
        aria-label={`Report: ${file.display_name}`}
        // Empty sandbox: no scripts, forms, popups, downloads or app origin.
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={report.srcdoc}
      />
    </div>
  );
}
