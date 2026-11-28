import { useCallback, useEffect, useRef, useState } from "react";
import { useAvailability } from "@/features/sync-review/availability";
import { useSyncStatus } from "@/features/sync/sync-status";
import {
  attachments,
  type Attachment,
  type DriveCopyInspection,
  type PreviewInfo,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { syncApi } from "@/lib/sync-api";
import { purged } from "./file-words";

export type PreviewTarget =
  { uri: string } | { id: string; initial?: Attachment };

/**
 * Everything the preview knows and does about one file, shared by the viewer
 * dialog and the library's detail pane. Viewing never edits content.
 */
export function usePreview(
  target: PreviewTarget,
  warm?: Map<string, PreviewInfo>,
) {
  const initial = "initial" in target ? (target.initial ?? null) : null;
  const [file, setFile] = useState<Attachment | null>(initial);
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [copy, setCopy] = useState<DriveCopyInspection | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refreshDrive = useCallback(() => setAttempt((value) => value + 1), []);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const id = "id" in target ? target.id : undefined;
  const uri = "uri" in target ? target.uri : undefined;
  // The viewer steps through files without remounting: a new target starts from
  // nothing of the last one's state. A neighbor read ahead shows at once and is
  // still read again, so the state shown is never older than this open.
  const identity = `${id ?? ""}|${uri ?? ""}`;
  const [shown, setShown] = useState(identity);
  // Counts the viewer's visits: stepping away and back to a file is a new visit, so an
  // action started on the first cannot settle the second's state.
  const [visit, setVisit] = useState(0);
  // What the viewer shows now, for work that finishes later: it must not touch
  // the state of a file that was stepped to in the meantime.
  const latest = useRef({
    identity,
    visit,
    fileId: undefined as string | undefined,
  });
  if (shown !== identity) {
    setShown(identity);
    setVisit((value) => value + 1);
    setFile(initial);
    setInfo((id && warm?.get(id)) || null);
    setCopy(null);
    setFailed(false);
    setError(null);
    setBusy(false);
  }
  const availability = useAvailability(
    file && file.kind !== "external_reference" ? [file.id] : [],
  );
  useEffect(() => {
    latest.current = { identity, visit, fileId: file?.id };
  });
  const stored = file ? availability.of(file.id) : undefined;
  // The bytes are still in the sync storage, or on their way: there is nothing to preview
  // yet. Once they arrive the preview is read again.
  const awaited = stored !== undefined && stored.state !== "downloaded";
  const absent = stored?.state === "not_downloaded" ? stored.id : "";
  const sync = useSyncStatus();
  // The storage wants the person back before it hands the file over.
  const signedOut =
    absent !== "" &&
    (sync.status?.recovery === "authorization_expired" ||
      error?.code === "not_signed_in" ||
      error?.code === "unauthenticated");
  const { download } = availability;
  // Where Attachments download when opened, opening one is what fetches it:
  // once per file, so a download that failed waits for the Download button, even
  // after the viewer stepped away and came back.
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    if (!absent || fetched.current.has(absent)) return;
    fetched.current.add(absent);
    void syncApi
      .settings()
      .then((settings) =>
        settings.attachment_download === "on_open"
          ? download(absent)
          : undefined,
      )
      .catch((reason: unknown) => {
        // The failure belongs to the file that started the download.
        if (latest.current.fileId === absent)
          setError(describeFailure(reason, "download"));
      });
  }, [absent, download]);
  useEffect(() => {
    const current = ++generation.current;
    let read = false;
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
      read = true;
      setCopy(null);
      if (preview.attachment.kind === "external_reference") {
        const inspection = await attachments.inspectDriveCopy(resolved);
        if (generation.current === current) setCopy(inspection);
      }
    })().catch((reason: unknown) => {
      if (generation.current !== current) return;
      // A neighbor read ahead is not kept over a read of the file itself that failed.
      if (!read) setInfo(null);
      setError(describeFailure(reason, "load the preview"));
    });
    return () => {
      generation.current += 1;
    };
  }, [id, uri, attempt, awaited]);
  async function action(verb: string, run: () => Promise<void>) {
    // The same file's metadata may reload while this runs (its download finished);
    // only a new visit (stepping to a file, even back to this one) hands the viewer's
    // state over.
    const target = latest.current.visit;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (reason) {
      if (latest.current.visit === target)
        setError(describeFailure(reason, verb));
    } finally {
      if (latest.current.visit === target) setBusy(false);
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
  /** Reads the file again: after a transient failure, or a change elsewhere. */
  function retry() {
    setInfo(null);
    setFailed(false);
    setError(null);
    setAttempt((value) => value + 1);
  }
  /** Reads the file again, but only while it is still the one shown. */
  function retryIfShown(fileId: string) {
    if (latest.current.fileId === fileId) retry();
  }
  function renamed(next: Attachment) {
    setFile(next);
    setInfo((previous) =>
      previous ? { ...previous, attachment: next } : null,
    );
  }
  const external = file?.kind === "external_reference";
  const uploadedCopy =
    file?.uploaded_copy === true ||
    info?.uploaded_copy === true ||
    copy !== null;
  return {
    file,
    info,
    copy,
    workspace,
    attempt,
    refreshDrive,
    failed,
    mediaFailed,
    retry,
    retryIfShown,
    renamed,
    error,
    setError,
    busy,
    action,
    availability,
    stored,
    awaited,
    signedOut,
    external,
    uploadedCopy,
    gone: file ? purged(file) : false,
    // A file still in the sync storage reads as missing here; it is waiting, not lost.
    missing:
      !awaited &&
      availability.known &&
      (info?.status === "missing" || info?.status === "incomplete"),
    link:
      workspace && file ? `<ticketd://attachment/${workspace}/${file.id}>` : "",
  };
}

export type Preview = ReturnType<typeof usePreview>;

/** Reads the neighbors' previews ahead of a step, so the next file shows at once. */
export function useReadAhead(
  ids: string[],
  ready: boolean,
  warm: Map<string, PreviewInfo>,
) {
  const key = ids.join("\n");
  useEffect(() => {
    if (!ready || !key) return;
    let active = true;
    void attachments
      .workspaceId()
      .then(async (workspace) => {
        for (const id of key.split("\n")) {
          if (!active || warm.has(id)) continue;
          // One neighbor that will not read does not stop the others.
          try {
            warm.set(id, await attachments.preview(workspace, id));
          } catch {
            // A step to it reads it again and shows why.
          }
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [key, ready, warm]);
}
