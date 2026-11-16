import { useEffect } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { describeFailure } from "@/lib/api/describe-failure";
import type { PageZoom } from "./use-page-zoom";

/** Reuse the shell's status line, including anchored raw Details and Retry. */
export function PageZoomStatus({ zoom }: { zoom: PageZoom }) {
  const line = useStatusLine();
  const { outcome, retry } = zoom;
  useEffect(() => {
    if (!outcome) return;
    if ("error" in outcome) {
      const failure = describeFailure(outcome.error, "change zoom");
      line.show({
        tone: "error",
        message: "Couldn't change zoom. Your previous zoom is kept. Try again.",
        details: failure.details,
        action: { label: "Retry", run: () => retry(outcome.percent) },
      });
    } else line.show({ message: `Zoom ${outcome.percent}%` });
  }, [line, outcome, retry]);
  return null;
}
