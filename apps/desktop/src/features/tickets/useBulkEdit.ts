import { useRef, useState } from "react";
import { client, type BulkChange } from "@/lib/api/client";

/**
 * Bulk edit state for the ticket list: the selection, the open action, form
 * drafts, and request submission. A retry of the same selection and change
 * reuses its request ID so the core can deduplicate it.
 */
export function useBulkEdit(refresh: () => Promise<void>) {
  const [selection, setSelection] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [project, setProject] = useState("");
  const [effort, setEffort] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);

  async function submit(
    change: unknown,
    send: (requestId: string) => Promise<unknown>,
    clearDrafts: () => void,
  ) {
    const key = JSON.stringify([selection, change]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      await send(request.current.id);
      request.current = null;
      setSelection([]);
      setAction(null);
      clearDrafts();
      await refresh();
    } catch (reason) {
      setError(
        `Could not change selected tickets: ${String(reason)}. Check the selection and retry.`,
      );
    } finally {
      setPending(false);
    }
  }

  return {
    selection,
    status,
    setStatus,
    project,
    setProject,
    effort,
    setEffort,
    tag,
    setTag,
    error,
    action,
    setAction,
    pending,
    toggle(reference: string) {
      const next = selection.includes(reference)
        ? selection.filter((item) => item !== reference)
        : [...selection, reference];
      setSelection(next);
      if (next.length === 0) setAction(null);
    },
    clearSelection() {
      setSelection([]);
      setAction(null);
    },
    /** Drops the selection and any pending retry, e.g. after a restore. */
    reset() {
      setSelection([]);
      setAction(null);
      request.current = null;
    },
    applyStatus: () =>
      submit(
        status,
        (id) => client.bulkStatus(selection, status, id),
        () => setStatus(""),
      ),
    applyOrganization: (change: BulkChange) =>
      submit(
        change,
        (id) => client.bulkChange(selection, change, id),
        () => {
          setProject("");
          setEffort("");
          setTag("");
        },
      ),
  };
}

export type BulkEdit = ReturnType<typeof useBulkEdit>;
