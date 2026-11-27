import { useEffect, useState, type RefObject } from "react";
import { FailureState } from "@/components/ui/failure-alert";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { ImageStage } from "./ImageStage";
import { PreviewLoading } from "./PreviewState";
import type { StageKeys } from "./PdfStage";

/** An SVG is read whole, so a larger one stays source text (the picture limit). */
export const SVG_LIMIT = 5 * 1024 * 1024;

type Loaded =
  { key: string; url: string } | { key: string; failure: FailureDescription };

/**
 * A stored SVG as a picture. It is drawn by an `<img>` from a data address, never
 * as a document: an image context runs no script, loads nothing from the network
 * and follows no link, so the file is only ever a still.
 */
export function SvgStage({
  workspace,
  file,
  attempt,
  onRetry,
  onError,
  scrollerRef,
  keysRef,
}: {
  workspace: string;
  file: Attachment;
  attempt: number;
  onRetry: () => void;
  onError: () => void;
  scrollerRef: RefObject<HTMLElement | null>;
  keysRef: StageKeys;
}) {
  const key = `${workspace}/${file.id}/${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    attachments.text(workspace, file.id).then(
      (source) => {
        if (active)
          setLoaded({
            key,
            url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`,
          });
      },
      (reason: unknown) => {
        if (active)
          setLoaded({
            key,
            failure: describeFailure(reason, "read the image"),
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
  return (
    <ImageStage
      file={file}
      url={current.url}
      onError={onError}
      scrollerRef={scrollerRef}
      keysRef={keysRef}
    />
  );
}
