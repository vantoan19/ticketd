import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Download, ExternalLink, File, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  attachments,
  type Attachment,
  type PreviewInfo,
  type DriveCopyInspection,
} from "@/lib/api/attachments";
import { AttachmentPicker } from "./AttachmentPicker";
import { DriveReferenceDetails } from "./DriveReferenceDetails";
import { DriveAccessRecovery } from "./DriveAccessRecovery";
import { ExportMarkdownButton } from "./ExportMarkdown";
import { formatSize } from "./format-size";
import { formatDateTime } from "@/lib/format";
import { CopySourceButton } from "@/features/markdown/CopySourceButton";
import { DocumentNavigation } from "@/features/documents/navigation";
import { TicketNavigation } from "@/features/tickets/navigation";
import { RenameAttachment } from "./RenameAttachment";
import "./attachment-preview.css";
import {
  storageWord,
  useAvailability,
} from "@/features/sync-review/availability";
import { syncApi } from "@/lib/sync-api";

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
  const [copy, setCopy] = useState<DriveCopyInspection | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refreshDrive = useCallback(() => setAttempt((value) => value + 1), []);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const openDocument = useContext(DocumentNavigation);
  const openTicket = useContext(TicketNavigation);
  const generation = useRef(0);
  const replacementRequest = useRef<AbortController | null>(null);
  useEffect(() => () => replacementRequest.current?.abort(), []);
  function close() {
    replacementRequest.current?.abort();
    onClose();
  }
  const id = "id" in target ? target.id : undefined;
  const uri = "uri" in target ? target.uri : undefined;
  const availability = useAvailability(
    file && file.kind !== "external_reference" ? [file.id] : [],
  );
  const stored = file ? availability.of(file.id) : undefined;
  // The bytes are still in Drive, or on their way: there is nothing to preview
  // yet. Once they arrive the preview is read again.
  const awaited = stored !== undefined && stored.state !== "downloaded";
  const absent = stored?.state === "not_downloaded" ? stored.id : "";
  const { download } = availability;
  // Where Attachments download when opened, opening one is what fetches it:
  // once per file, so a download that failed waits for the Download button.
  const fetched = useRef("");
  useEffect(() => {
    if (!absent || fetched.current === absent) return;
    fetched.current = absent;
    void syncApi
      .settings()
      .then((settings) =>
        settings.attachment_download === "on_open"
          ? download(absent)
          : undefined,
      )
      .catch((reason: unknown) =>
        setError(describeFailure(reason, "download the file")),
      );
  }, [absent, download]);
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
      setCopy(null);
      if (preview.attachment.kind === "external_reference") {
        const inspection = await attachments.inspectDriveCopy(resolved);
        if (generation.current === current) setCopy(inspection);
      }
    })().catch((reason: unknown) => {
      if (generation.current === current)
        setError(describeFailure(reason, "load the preview"));
    });
    return () => {
      generation.current += 1;
    };
  }, [id, uri, attempt, awaited]);
  async function action(verb: string, run: () => Promise<void>) {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (reason) {
      if (generation.current === current)
        setError(describeFailure(reason, verb));
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
  const uploadedCopy =
    file?.uploaded_copy === true ||
    info?.uploaded_copy === true ||
    copy !== null;
  const storage = storageWord(stored);
  const available =
    !external && !awaited && info?.status === "available" && !failed;
  const purgeUnavailable =
    file?.purge_state === "pending" || file?.purge_state === "purged";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent variant="flush" size="viewer">
        <div className="attachment-preview-frame">
          <div className="attachment-preview-header">
            <div className="attachment-preview-heading">
              <DialogTitle>{file?.display_name ?? "Attachment"}</DialogTitle>
              <DialogDescription>
                {external
                  ? uploadedCopy
                    ? "Google Drive · Uploaded copy"
                    : "Google Drive · External reference"
                  : storage}
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
                    disabled={busy || awaited || info?.can_open === false}
                    onClick={() =>
                      void action("open the file", () =>
                        attachments.open(file.id),
                      )
                    }
                  >
                    <ExternalLink aria-hidden="true" />
                    {external ? "Open in Drive" : "Open file"}
                  </Button>
                  {external && workspace && (
                    <ExportMarkdownButton
                      label={uploadedCopy ? "Export" : "Export link"}
                      source={{
                        kind: "markdown",
                        body: `<ticketd://attachment/${workspace}/${file.id}>`,
                      }}
                    />
                  )}
                  {!external && (
                    <Button
                      variant="ghost"
                      disabled={busy || purgeUnavailable}
                      onClick={() =>
                        void action("export the file", () =>
                          attachments.export(file),
                        )
                      }
                    >
                      <Download aria-hidden="true" />
                      Export file
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="attachment-preview-layout">
            <div className="attachment-preview-stage">
              {external && file ? (
                <DriveAccessRecovery
                  id={file.id}
                  onRefresh={refreshDrive}
                  uploadedCopy={uploadedCopy}
                  copy={copy}
                />
              ) : available && file && info.media_type ? (
                <Media
                  key={`${workspace}/${file.id}/${attempt}`}
                  file={file}
                  mime={info.media_type}
                  url={attachments.mediaUrl(workspace, file.id)}
                  onError={mediaFailed}
                />
              ) : awaited && file ? (
                <div className="attachment-preview-fallback">
                  <File aria-hidden="true" />
                  <h3>{storage}</h3>
                  <p role="status">This file is in your Google Drive.</p>
                  {stored.state === "not_downloaded" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action("download the file", () =>
                          availability.download(file.id),
                        )
                      }
                    >
                      <Download aria-hidden="true" />
                      Download
                    </Button>
                  )}
                  {error && <FailureAlert size="compact" failure={error} />}
                </div>
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
                        setError(null);
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
                      void action("restore the file", async () => {
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
                    <dt>Added</dt>
                    <dd>
                      {file.added_at ? (
                        <time dateTime={file.added_at}>
                          {formatDateTime(file.added_at)}
                        </time>
                      ) : (
                        <Tooltip content="No registration date was recorded">
                          <span tabIndex={0}>Unknown</span>
                        </Tooltip>
                      )}
                    </dd>
                    {external ? (
                      <DriveReferenceDetails
                        id={file.id}
                        revision={attempt}
                        uploadedCopy={uploadedCopy}
                      />
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
                        <dd>{storage}</dd>
                      </>
                    )}
                  </dl>
                  <div className="attachment-actions">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRenaming(true)}
                    >
                      Rename
                    </Button>
                    {workspace && !purgeUnavailable && !file.quarantined && (
                      <CopySourceButton
                        label="Reuse attachment"
                        source={`<ticketd://attachment/${workspace}/${file.id}>`}
                      />
                    )}
                  </div>
                  {!purgeUnavailable && !file.quarantined && (
                    <p className="attachment-hint">
                      Reuse copies a link to paste into another ticket, Document
                      or update.
                    </p>
                  )}
                  {info && (
                    <section className="attachment-preview-usage">
                      <h3>Used in {info.usage.total}</h3>
                      <ul aria-label="Attachment usage">
                        {info.usage.entries.map((entry) => (
                          <li key={`${entry.kind}:${entry.owner}`}>
                            {(entry.target?.kind === "ticket" && openTicket) ||
                            (entry.target?.kind === "document" &&
                              openDocument) ? (
                              <button
                                type="button"
                                className="context-link"
                                onClick={() => {
                                  close();
                                  if (entry.target?.kind === "ticket")
                                    openTicket?.(entry.target.id);
                                  else if (entry.target?.kind === "document")
                                    openDocument?.(entry.target.id);
                                }}
                              >
                                {entry.label}
                              </button>
                            ) : (
                              <strong>{entry.label}</strong>
                            )}
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
                      Only this reference changes. Other uses keep their
                      original attachment.
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
              {/* While the file waits in Drive, the preview pane shows the failure. */}
              {error && !awaited && (
                <FailureAlert size="compact" failure={error} />
              )}
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
                ? "Google Drive · Removing a link keeps the file in Drive."
                : purgeUnavailable
                  ? "Local bytes are unavailable. Its name, identity and references are preserved."
                  : awaited
                    ? `${storage} · Removing a link keeps this file in your Drive.`
                    : "Local snapshot · Removing a link keeps this file in your workspace."}
            </p>
            <div className="attachment-actions">
              <Button variant="ghost" onClick={close}>
                Done
              </Button>
            </div>
          </footer>
        </div>
        {renaming && file && (
          <RenameAttachment
            file={file}
            onClose={() => setRenaming(false)}
            onRenamed={(next) => {
              setFile(next);
              setInfo((previous) =>
                previous ? { ...previous, attachment: next } : previous,
              );
            }}
          />
        )}
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
                  "That file is already attached here. Choose a different file.",
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
