import { useEffect, useRef, useState, type RefObject } from "react";
import { Info } from "lucide-react";
import { FailureState } from "@/components/ui/failure-alert";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { prepareReport, type PreparedReport } from "./html-report";
import { extensionLabel } from "./file-words";
import { PreviewLoading, PreviewState } from "./PreviewState";

type Loaded =
  | { key: string; report: PreparedReport }
  | { key: string; failure: FailureDescription };

/**
 * Key events inside a sandboxed frame never reach the viewer, so Esc, J and K
 * would go dead the moment the report is clicked. The frame cannot be given a
 * script to forward them without weakening its isolation. Instead, when a click
 * moves focus into the frame, focus goes straight back to the stage: wheel,
 * touch and scrollbar scrolling and mouse selection need no focus and carry on.
 * A person who Tabs into the frame chose it (arrow and Space scrolling need its
 * focus), so that arrival is left alone.
 */
const TAB_ARRIVAL_MS = 150;
function useFocusStaysOutside(frame: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    let tabbedAt = Number.NEGATIVE_INFINITY;
    const noteTab = (event: KeyboardEvent) => {
      if (event.key === "Tab") tabbedAt = event.timeStamp;
    };
    const onBlur = (blur: Event) => {
      // Focus arrives in the frame after the window's blur; look once it settled.
      setTimeout(() => {
        const element = frame.current;
        if (!element || document.activeElement !== element) return;
        // The window itself losing focus is not a click into the frame.
        if (!document.hasFocus()) return;
        if (blur.timeStamp - tabbedAt < TAB_ARRIVAL_MS) return;
        const holder =
          element.parentElement?.closest<HTMLElement>("[tabindex]");
        holder?.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener("keydown", noteTab, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", noteTab, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [frame]);
}

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
  const frame = useRef<HTMLIFrameElement>(null);
  useFocusStaysOutside(frame);
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
  if (!current) return <PreviewLoading />;
  if ("failure" in current)
    return <FailureState failure={current.failure} onRetry={onRetry} />;
  const { report } = current;
  if (report.unusable)
    return (
      <PreviewState
        family="text"
        label={extensionLabel(file.original_filename)}
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
        ref={frame}
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
