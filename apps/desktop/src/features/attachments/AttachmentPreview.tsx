import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, File, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  attachments,
  type Attachment,
  type PreviewInfo,
} from "@/lib/api/attachments";
import { AttachmentPicker } from "./AttachmentPicker";
import { DriveReferenceDetails } from "./DriveReferenceDetails";
import { formatSize } from "./format-size";
import "./attachment-preview.css";

export type PreviewTarget =
  { uri: string } | { id: string; initial?: Attachment };
export type ReferenceReplacement = (
  file: Attachment,
  requestId: string,
  signal: AbortSignal,
) => Promise<void>;
const usageKinds: Record<string, string> = {
  ticket_attachment: "Direct ticket attachment",
  ticket_body: "Ticket description",
  document_body: "Document",
  activity_brief: "Update brief",
  draft: "Recoverable draft",
  undo: "Retained for Undo",
};

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
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = media.current;
    const picture = image.current;
    // Strict Mode rehearses cleanup/setup; restore sources on each setup too.
    picture?.setAttribute("src", url);
    element?.setAttribute("src", url);
    return () => {
      picture?.removeAttribute("src");
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  if (mime.startsWith("image/"))
    return (
      <img ref={image} src={url} alt={file.display_name} onError={onError} />
    );
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

/** Viewing never edits content; only the supplied selected-reference callback may replace it. */
export function AttachmentPreview({
  target,
  onClose,
  onReplace,
  actions,
}: {
  target: PreviewTarget;
  onClose: () => void;
  onReplace?: ReferenceReplacement | undefined;
  actions?: ReactNode;
}) {
  const [file, setFile] = useState<Attachment | null>(
    "initial" in target ? (target.initial ?? null) : null,
  );
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const generation = useRef(0);
  const replacementRequest = useRef<AbortController | null>(null);
  useEffect(() => () => replacementRequest.current?.abort(), []);
  function close() {
    replacementRequest.current?.abort();
    onClose();
  }
  const id = "id" in target ? target.id : undefined;
  const uri = "uri" in target ? target.uri : undefined;
  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      const owningWorkspace = await attachments.workspaceId();
      const resolvedFile = id ? null : await attachments.resolve(uri ?? "");
      if (resolvedFile && generation.current === current) setFile(resolvedFile);
      const resolved = id ?? resolvedFile?.id ?? "";
      const preview = await attachments.preview(owningWorkspace, resolved);
      if (generation.current !== current) return;
      setWorkspace(owningWorkspace);
      setFile(preview.attachment);
      setInfo(preview);
    })().catch((reason: unknown) => {
      if (generation.current === current) setError(String(reason));
    });
    return () => {
      generation.current += 1;
    };
  }, [id, uri, attempt]);
  async function action(run: () => Promise<void>) {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (reason) {
      if (generation.current === current) setError(String(reason));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  function mediaFailed() {
    setFailed(true);
    if (!file) return;
    const current = generation.current;
    // A decode error alone cannot distinguish unsupported codecs from lost bytes.
    void attachments
      .preview(workspace, file.id)
      .then((next) => {
        if (generation.current === current) {
          setInfo(next);
          setFile(next.attachment);
        }
      })
      .catch(() => {});
  }
  const external = file?.kind === "external_reference";
  const available = !external && info?.status === "available" && !failed;
  const purgeUnavailable =
    file?.purge_state === "pending" || file?.purge_state === "purged";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="attachment-preview-dialog">
        <DialogHeader className="attachment-preview-header">
          <div className="attachment-preview-heading">
            <DialogTitle>{file?.display_name ?? "Attachment"}</DialogTitle>
            <DialogDescription>
              {external
                ? "Google Drive · External reference"
                : "Local snapshot"}
              {file?.size_bytes != null
                ? ` · ${formatSize(file.size_bytes)}`
                : ""}
            </DialogDescription>
          </div>
          <div className="attachment-preview-file-actions">
            {file && (
              <>
                <Button
                  variant="outline"
                  disabled={busy || info?.can_open === false}
                  onClick={() => void action(() => attachments.open(file.id))}
                >
                  <ExternalLink aria-hidden="true" />
                  {external ? "Open in Drive" : "Open file"}
                </Button>
                {!external && (
                  <Button
                    variant="ghost"
                    disabled={busy || purgeUnavailable}
                    onClick={() => void action(() => attachments.export(file))}
                  >
                    <Download aria-hidden="true" />
                    Export file
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogHeader>
        <div className="attachment-preview-layout">
          <div className="attachment-preview-stage">
            {available && file && info.media_type ? (
              <Media
                key={`${workspace}/${file.id}/${attempt}`}
                file={file}
                mime={info.media_type}
                url={attachments.mediaUrl(workspace, file.id)}
                onError={mediaFailed}
              />
            ) : (
              <div className="attachment-preview-fallback">
                <File aria-hidden="true" />
                <h3>
                  {file?.purge_state === "purged"
                    ? "File permanently purged"
                    : file?.purge_state === "pending"
                      ? "Permanent purge pending"
                      : info?.status === "missing"
                        ? "The local file could not be found"
                        : info?.status === "incomplete"
                          ? "Stored bytes are incomplete"
                          : info || error
                            ? "Preview unavailable"
                            : "Loading preview…"}
                </h3>
                <p>
                  {info?.message ??
                    (failed
                      ? "This media could not be displayed. Try again, or open or export it explicitly."
                      : "Its identity, name and references are preserved.")}
                </p>
                {(info || error) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setInfo(null);
                      setFailed(false);
                      setError("");
                      setAttempt((value) => value + 1);
                    }}
                  >
                    <RefreshCw aria-hidden="true" />
                    Retry
                  </Button>
                )}
              </div>
            )}
          </div>
          <aside className="attachment-preview-info">
            <h3>File details</h3>
            {file?.quarantined && !purgeUnavailable && (
              <section>
                <p>Quarantined · Restore this file to reuse it.</p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await attachments.restore(file.id, crypto.randomUUID());
                      setAttempt((value) => value + 1);
                    })
                  }
                >
                  Restore file
                </Button>
              </section>
            )}
            {file && (
              <>
                <dl className="attachment-metadata">
                  {external ? (
                    <DriveReferenceDetails id={file.id} />
                  ) : (
                    <>
                      <dt>Type</dt>
                      <dd>{info?.media_type ?? "File"}</dd>
                      {file.size_bytes != null && (
                        <>
                          <dt>Size</dt>
                          <dd>{formatSize(file.size_bytes)}</dd>
                        </>
                      )}
                      <dt>Storage</dt>
                      <dd>Local snapshot</dd>
                    </>
                  )}
                </dl>
                {info && (
                  <section className="attachment-preview-usage">
                    <h3>Used in {info.usage.total}</h3>
                    <ul aria-label="Attachment usage">
                      {info.usage.entries.map((entry) => (
                        <li key={`${entry.kind}:${entry.owner}`}>
                          <strong>{entry.label}</strong>
                          <small>
                            {usageKinds[entry.kind] ?? entry.kind}
                            {entry.trashed ? " · Trash" : ""}
                          </small>
                        </li>
                      ))}
                    </ul>
                    {info.usage.total > info.usage.entries.length && (
                      <p className="attachment-hint">
                        Showing {info.usage.entries.length} of{" "}
                        {info.usage.total} uses.
                      </p>
                    )}
                    {info.usage.total === 0 && (
                      <p className="attachment-hint">No recorded uses.</p>
                    )}
                    {info.usage.legacy_drafts_pending && (
                      <p className="attachment-hint">
                        Older recovery drafts still need review. These are the
                        recorded uses.
                      </p>
                    )}
                  </section>
                )}
                {onReplace && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      replacementRequest.current?.abort();
                      replacementRequest.current = new AbortController();
                      setPicker(true);
                    }}
                  >
                    Choose a replacement
                  </Button>
                )}
                {onReplace && (
                  <p className="attachment-hint">
                    Only this reference changes. Other uses keep their original
                    attachment.
                  </p>
                )}
                <details>
                  <summary>Original name &amp; identity</summary>
                  <dl className="attachment-metadata">
                    <dt>Original filename</dt>
                    <dd>{file.original_filename}</dd>
                    <dt>Attachment ID</dt>
                    <dd>
                      <code>{file.id}</code>
                    </dd>
                  </dl>
                </details>
              </>
            )}
            {error && <p role="alert">{error}</p>}
            {!external && info?.can_open === false && (
              <small className="attachment-hint">
                Open is unavailable for this file. Export preserves its bytes
                when available; choose an application explicitly.
              </small>
            )}
            {actions}
          </aside>
        </div>
        <footer className="attachment-preview-footer">
          <p className="attachment-hint">
            {external
              ? "Removing a link keeps this external reference in your workspace."
              : purgeUnavailable
                ? "Local bytes are unavailable. Its name, identity and references are preserved."
                : "Local snapshot · Removing a link keeps this file in your workspace."}
          </p>
          <div className="attachment-actions">
            <Button variant="ghost" onClick={close}>
              Done
            </Button>
          </div>
        </footer>
        {picker && onReplace && (
          <AttachmentPicker
            open
            onOpenChange={(open) => {
              if (!open) replacementRequest.current?.abort();
              setPicker(open);
            }}
            single
            onPick={async (replacement, requestId) => {
              if (replacement.id === file?.id)
                throw new Error(
                  "Choose a different attachment identity for this reference.",
                );
              const signal = replacementRequest.current?.signal;
              if (!signal)
                throw new Error(
                  "Select the reference again before replacing it.",
                );
              signal.throwIfAborted();
              await onReplace(replacement, requestId, signal);
              close();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
