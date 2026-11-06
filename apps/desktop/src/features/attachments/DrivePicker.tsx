import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { attachments, type Attachment } from "@/lib/api/attachments";

export function DrivePicker({
  onPick,
  onComplete,
  single = false,
}: {
  single?: boolean;
  onPick: (
    file: Attachment,
    requestId: string,
    beforeId?: string,
  ) => Promise<void>;
  onComplete: () => void;
}) {
  const [configuration, setConfiguration] = useState<{
    configured: boolean;
    message: string;
  } | null>(null);
  const [files, setFiles] = useState<
    {
      file: Attachment;
      requestId: string;
      selected: boolean;
      beforeId?: string;
    }[]
  >([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void attachments
      .driveConfiguration()
      .then((value) => {
        if (mounted.current) setConfiguration(value);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(String(reason));
      });
    return () => {
      mounted.current = false;
      if (operation.current)
        void attachments
          .cancelDriveSelection(operation.current)
          .catch(() => {});
    };
  }, []);
  async function choose() {
    const id = crypto.randomUUID();
    operation.current = id;
    setSelecting(true);
    setBusy(true);
    setError("");
    try {
      const selected = await attachments.selectDrive(id);
      if (!mounted.current || operation.current !== id) return;
      setFiles(
        selected.files.map((file) => ({
          file,
          requestId: crypto.randomUUID(),
          selected: true,
        })),
      );
      setError(selected.failures.join("\n"));
    } catch (reason) {
      if (mounted.current && operation.current === id) setError(String(reason));
    } finally {
      if (operation.current === id) {
        operation.current = null;
        if (mounted.current) {
          setBusy(false);
          setSelecting(false);
        }
      }
    }
  }
  async function cancel() {
    if (!operation.current) return;
    const id = operation.current;
    try {
      await attachments.cancelDriveSelection(id);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    }
  }
  async function attach() {
    if (single && files.filter((item) => item.selected).length !== 1) {
      setError("Choose exactly one file to replace this reference.");
      return;
    }
    setBusy(true);
    setError("");
    const failed: (typeof files)[number][] = [];
    const failures: string[] = [];
    try {
      for (const selected of files.filter((item) => item.selected)) {
        if (!mounted.current) return;
        try {
          if (selected.beforeId)
            await onPick(selected.file, selected.requestId, selected.beforeId);
          else await onPick(selected.file, selected.requestId);
          // A failed earlier file retries before the first later success.
          for (const item of failed) item.beforeId ??= selected.file.id;
          if (mounted.current)
            setFiles((current) =>
              current.filter((item) => item.requestId !== selected.requestId),
            );
        } catch (reason) {
          failed.push({ ...selected });
          failures.push(`${selected.file.display_name}: ${String(reason)}`);
        }
      }
      if (mounted.current && !failures.length) onComplete();
      else if (mounted.current) {
        setFiles((current) =>
          current.map(
            (item) =>
              failed.find((failure) => failure.requestId === item.requestId) ??
              item,
          ),
        );
        setError(
          `${failures.join("; ")}. Retry Add selected, or reuse from Existing files. Drive content is unchanged.`,
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="attachment-existing">
      <div className="attachment-drive-connection">
        <strong>Your Google Drive</strong>
        <small>Using your existing file permissions</small>
      </div>
      <p className="attachment-hint">
        External references show current Drive content. Google Docs, Sheets and
        Slides open in Drive.
      </p>
      {configuration && !configuration.configured && (
        <>
          <p role="status">Google Drive setup is required before connecting.</p>
          <details className="attachment-hint">
            <summary className="cursor-pointer">Setup instructions</summary>
            <p className="mt-2 wrap-anywhere">{configuration.message}</p>
          </details>
        </>
      )}
      <Button
        disabled={busy || !configuration?.configured}
        onClick={() => void choose()}
      >
        Choose in Google Drive
      </Button>
      {selecting && (
        <>
          <p role="status">
            Choose files in your system browser, then return here.
          </p>
          <Button variant="outline" onClick={() => void cancel()}>
            Cancel Drive selection
          </Button>
        </>
      )}
      {!!files.length && (
        <Input
          aria-label="Search selected Drive files"
          placeholder="Search selected Drive files…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <ul aria-label="Selected Drive files">
        {files
          .filter(({ file }) =>
            file.display_name
              .toLocaleLowerCase()
              .includes(search.toLocaleLowerCase()),
          )
          .map((selected) => (
            <li key={selected.file.id}>
              <label className="attachment-row">
                <input
                  type="checkbox"
                  aria-label={selected.file.display_name}
                  checked={selected.selected}
                  disabled={busy}
                  onChange={(event) =>
                    setFiles((current) =>
                      current.map((item) =>
                        item === selected
                          ? { ...item, selected: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <span>
                  {selected.file.display_name}
                  <small>Google Drive · External reference</small>
                </span>
              </label>
            </li>
          ))}
      </ul>
      <p className="attachment-drive-notice">
        Only files you select are authorized for ticketd. Sharing permissions
        stay unchanged.
      </p>
      {!!files.length && (
        <p className="attachment-hint">
          Selected files remain available in Existing files if you close this
          dialog. No local snapshot is created.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!!files.length && (
        <div className="attachment-actions">
          <small>
            {files.filter((item) => item.selected).length} selected · Linked to
            current Drive content
          </small>
          <Button
            disabled={busy || !files.some((item) => item.selected)}
            onClick={() => void attach()}
          >
            Add selected
          </Button>
        </div>
      )}
    </div>
  );
}
