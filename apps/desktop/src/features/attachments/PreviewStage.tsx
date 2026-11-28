import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { CloudDownload, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { Progress } from "@/components/ui/progress";
import { storageName } from "@/features/sync/storage-name";
import { useSyncStatus } from "@/features/sync/sync-status";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { syncApi } from "@/lib/sync-api";
import { DriveAccessRecovery } from "./DriveAccessRecovery";
import { HtmlStage } from "./HtmlStage";
import { ImageStage } from "./ImageStage";
import { PdfStage, type StageKeys } from "./PdfStage";
import { PreviewLoading, PreviewState, RetryActions } from "./PreviewState";
import { SVG_LIMIT, SvgStage } from "./SvgStage";
import { TextStage } from "./TextStage";
import { extensionLabel, fileType } from "./file-words";
import { formatProgress, formatSize } from "./format-size";
import type { Preview } from "./use-attachment-preview";

/** The largest file the app previews at all (100 MiB); a picture under it that is too large has too many pixels. */
const PREVIEW_BYTES = 100 * 1024 * 1024;

function Media({
  file,
  mime,
  url,
  onError,
}: {
  file: Attachment;
  mime: string;
  url: string;
  onError: () => void;
}) {
  const media = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const element = media.current;
    // Strict Mode rehearses cleanup/setup; restore the source on each setup too.
    element?.setAttribute("src", url);
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  const props = {
    src: url,
    controls: true,
    preload: "metadata",
    onError,
    "aria-label": file.display_name,
  } as const;
  return mime.startsWith("audio/") ? (
    <audio
      {...props}
      ref={(node) => {
        media.current = node;
      }}
    />
  ) : (
    <video
      {...props}
      ref={(node) => {
        media.current = node;
      }}
    />
  );
}

/** The recessed stage: the file itself, or one plain sentence about why not. */
export function PreviewStage({
  preview,
  onReplace,
  onRestoreBackup,
  onChanged,
  stageRef,
  place,
  fading = false,
}: {
  preview: Preview;
  /** The viewer's stage takes focus when it opens, so the reading keys work at once. */
  stageRef?: RefObject<HTMLDivElement | null>;
  /** "2 of 6", when the viewer steps through files. */
  place?: string | undefined;
  /** A file reached by Previous or Next fades in; the first one does not. */
  fading?: boolean;
  onReplace: (() => void) | undefined;
  onRestoreBackup: (() => void) | undefined;
  onChanged: (() => void) | undefined;
}) {
  const { file, info, busy, error, external, awaited, failed } = preview;
  const { apply, status: syncStatus } = useSyncStatus();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stageKeys: StageKeys = useRef(null);
  // The stage is also the scroller the formats lay themselves out in.
  const stage = useCallback(
    (element: HTMLDivElement | null) => {
      scroller.current = element;
      if (stageRef) stageRef.current = element;
    },
    [stageRef],
  );
  const type = fileType(file?.original_filename ?? "", info?.media_type);
  const provider = syncStatus?.provider;
  const storage = storageName(provider);
  const label = extensionLabel(file?.original_filename ?? "");
  // What the one sentence says a person can do with a file that has no preview.
  const see =
    type.family === "video"
      ? "watch it"
      : type.family === "audio"
        ? "listen to it"
        : "see it";
  const notice = file?.quarantined && !preview.gone && (
    <Alert size="compact">
      <Info aria-hidden="true" />
      <AlertDescription>
        Quarantined. Restore it to use it in new places.
      </AlertDescription>
      <Button
        variant="outline"
        size="compact"
        disabled={busy}
        onClick={() =>
          void preview.action("restore the file", async () => {
            await attachments.restore(file.id, crypto.randomUUID());
            preview.retryIfShown(file.id);
            onChanged?.();
          })
        }
      >
        Restore file
      </Button>
    </Alert>
  );
  let body: ReactNode;
  let reportShown = false;
  let pdfShown = false;
  let pictureShown = false;
  let textShown = false;
  if (external && file)
    body = (
      <DriveAccessRecovery
        id={file.id}
        onRefresh={preview.refreshDrive}
        uploadedCopy={preview.uploadedCopy}
        copy={preview.copy}
        family={type.family}
        label={`${label === "FILE" ? "DRIVE" : label} ↗`}
      />
    );
  else if (file?.purge_state === "purged")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Deleted permanently"
        sentence="Its name stays in ticketd. The file itself can only come back from an older backup."
        action={
          onRestoreBackup && (
            <Button variant="outline" size="sm" onClick={onRestoreBackup}>
              Restore from a backup…
            </Button>
          )
        }
      />
    );
  else if (file?.purge_state === "pending")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Deleting permanently"
        sentence="ticketd started deleting its stored copy. Finish deleting it from the Attachments library."
      />
    );
  else if (preview.missing)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        attention
        title={
          info?.status === "incomplete"
            ? "Incomplete on this computer"
            : "Missing from this computer"
        }
        sentence="It may have been moved or deleted outside ticketd. Its name and the places that use it are kept."
        action={
          <>
            {onReplace && (
              <Button variant="outline" size="sm" onClick={onReplace}>
                Replace file…
              </Button>
            )}
            {onRestoreBackup && (
              <Button variant="ghost" size="sm" onClick={onRestoreBackup}>
                Restore from a backup…
              </Button>
            )}
          </>
        }
      />
    );
  else if (awaited && file) {
    const downloading = preview.stored?.state === "downloading";
    const size = file.size_bytes;
    const percent = preview.stored?.progress ?? null;
    const download = () =>
      void preview.action("download", () =>
        preview.availability.download(file.id),
      );
    const failure = preview.stored?.failure ?? null;
    const where = provider === "s3" ? storage.place : storage.full;
    if (preview.signedOut && !downloading)
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="status"
          attention
          title="Needs sign-in"
          sentence={`Sign in to ${provider === "s3" ? "AWS" : "Google"} to download this file.`}
          action={
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void preview.action("sign in", async () => {
                  apply(await syncApi.recover());
                })
              }
            >
              Sign in
            </Button>
          }
          extra={error && <FailureAlert size="compact" failure={error} />}
        />
      );
    else if (error && !downloading)
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="alert"
          title={error.title}
          sentence={error.sentence}
          action={<RetryActions onRetry={download} details={error.details} />}
        />
      );
    else if (failure !== null && !downloading)
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="alert"
          title="Couldn’t download"
          sentence={`${storage.full} didn’t answer. Nothing changed on this computer.`}
          action={
            <RetryActions
              onRetry={download}
              details={failure}
              disabled={busy}
            />
          }
        />
      );
    else
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="status"
          title={downloading ? "Downloading…" : "Not downloaded"}
          sentence={
            downloading
              ? size !== null && percent !== null
                ? formatProgress((size * Math.min(percent, 100)) / 100, size)
                : ""
              : `It’s in ${where}. Download it to preview it here.`
          }
          action={
            downloading ? (
              size !== null && percent !== null ? (
                <span className="attachment-state-progress">
                  <Progress value={percent} aria-label="Download progress" />
                </span>
              ) : null
            ) : preview.stored?.state === "not_downloaded" ? (
              <Button size="sm" disabled={busy} onClick={download}>
                <CloudDownload aria-hidden="true" />
                Download{size !== null && ` · ${formatSize(size)}`}
              </Button>
            ) : null
          }
        />
      );
  } else if (info && !preview.availability.known)
    // Until the storage says where the bytes are, a file read ahead must not
    // be read, nor taken for one with no preview: it may still be in Drive.
    body = <PreviewLoading shape={type.family === "pdf" ? "page" : "block"} />;
  else if (failed && file)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        role="alert"
        title={`Couldn’t show this ${type.word.toLowerCase()}`}
        sentence="ticketd may not play how it was saved. Open it in its app, or retry."
        action={<RetryActions onRetry={preview.retry} />}
      />
    );
  else if (info?.status === "available" && file && info.media_type) {
    const mediaKey = `${preview.workspace}/${file.id}/${preview.attempt}`;
    const mediaUrl = attachments.mediaUrl(preview.workspace, file.id);
    if (info.media_type.startsWith("image/")) {
      pictureShown = true;
      body = (
        <ImageStage
          key={mediaKey}
          file={file}
          url={mediaUrl}
          onError={preview.mediaFailed}
          scrollerRef={scroller}
          keysRef={stageKeys}
        />
      );
    } else
      body = (
        <Media
          key={mediaKey}
          file={file}
          mime={info.media_type}
          url={mediaUrl}
          onError={preview.mediaFailed}
        />
      );
  } else if (info?.status === "unavailable")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        role="alert"
        title="Couldn’t read this file"
        sentence="ticketd can’t read its stored copy on this computer."
        action={
          <RetryActions onRetry={preview.retry} details={info.message ?? ""} />
        }
      />
    );
  else if (info?.status === "unsupported" && file?.size_bytes === 0)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Empty file"
        sentence="It has no content, so there’s nothing to show."
      />
    );
  else if (info?.pdf && file) {
    pdfShown = true;
    body = (
      <PdfStage
        workspace={preview.workspace}
        file={file}
        attempt={preview.attempt}
        onRetry={preview.retry}
        scrollerRef={scroller}
        keysRef={stageKeys}
      />
    );
  } else if (info?.html && file) {
    reportShown = true;
    body = (
      <HtmlStage
        workspace={preview.workspace}
        file={file}
        attempt={preview.attempt}
        onRetry={preview.retry}
      />
    );
  } else if (
    info?.text &&
    file &&
    !info.text.partial &&
    info.text.total_bytes <= SVG_LIMIT &&
    /\.svg$/i.test(file.original_filename)
  ) {
    // An SVG is a picture, drawn as an image (never as a document).
    pictureShown = true;
    body = (
      <SvgStage
        key={`${preview.workspace}/${file.id}/${preview.attempt}`}
        workspace={preview.workspace}
        file={file}
        attempt={preview.attempt}
        onRetry={preview.retry}
        onError={preview.mediaFailed}
        scrollerRef={scroller}
        keysRef={stageKeys}
      />
    );
  } else if (info?.text && file) {
    textShown = true;
    body = (
      <TextStage
        workspace={preview.workspace}
        file={file}
        scope={info.text}
        attempt={preview.attempt}
        onRetry={preview.retry}
        scrollerRef={scroller}
        keysRef={stageKeys}
        reachable={!stageRef}
      />
    );
  } else if (info?.text_excerpt)
    body = (
      <div className="attachment-preview-textual">
        <pre
          className="attachment-preview-text"
          aria-label={`Text of ${file?.display_name ?? "the file"}`}
          tabIndex={0}
        >
          {info.text_excerpt.text}
        </pre>
        {info.text_excerpt.truncated && (
          <p className="attachment-preview-text-note">
            Showing the start of the file. Open it to read the rest.
          </p>
        )}
      </div>
    );
  else if (info?.status === "too_large")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Too large to preview"
        sentence={
          // A picture within the file-size limit is held back by its pixels, not its bytes.
          type.family === "image" &&
          file?.size_bytes != null &&
          file.size_bytes <= PREVIEW_BYTES
            ? "Its picture has too many pixels to show here. Open it in its app to see it."
            : `${file?.size_bytes != null ? `It’s ${formatSize(file.size_bytes)}. ` : ""}Open it in its app to ${see}.`
        }
      />
    );
  else if (info)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title={
          type.family === "file"
            ? "No preview for this file"
            : `No preview for ${type.family === "archive" ? `${type.word}s` : `${type.word} files`}`
        }
        sentence={`Open it in its app to ${type.family === "archive" ? "see what’s inside" : see}.`}
      />
    );
  else if (error && !awaited)
    body = <FailureState failure={error} onRetry={preview.retry} />;
  else
    body = <PreviewLoading shape={type.family === "pdf" ? "page" : "block"} />;
  return (
    <div
      ref={stage}
      className="attachment-preview-stage"
      // The format showing in the stage (a PDF's or picture's zoom keys) hears the keys first.
      onKeyDown={(event) => stageKeys.current?.(event)}
      {...(stageRef && {
        tabIndex: -1,
        role: "group",
        "aria-label": [file?.display_name ?? "File", type.word, place]
          .filter(Boolean)
          .join(", "),
      })}
      data-report={reportShown ? "" : undefined}
      data-pdf={pdfShown ? "" : undefined}
      data-picture={pictureShown ? "" : undefined}
      data-text={textShown ? "" : undefined}
    >
      {notice}
      <div
        // Another file is another canvas: it fades in rather than swapping.
        key={place ? (file?.id ?? "") : undefined}
        className="attachment-preview-canvas"
        data-fading={fading ? "" : undefined}
      >
        {body}
      </div>
    </div>
  );
}
