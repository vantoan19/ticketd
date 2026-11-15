import { useCallback, useEffect, useRef, useState } from "react";
import { client, type BulkChange } from "@/lib/api/client";
import { isWorkspaceCode, toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  sentence,
  type FailureDescription,
} from "@/lib/api/describe-failure";

const NOTICE_MS = 4000;

type Change =
  | { kind: "status"; status: string; summary: string }
  | { kind: "organization"; change: BulkChange; summary: string };

export type BulkFailure = {
  /** The ticket that prevented the batch, when the core named one. */
  reference: string | null;
  message: string;
  /** False when the core rejected the batch itself; sending it again fails the same way. */
  retryable: boolean;
  /** What the failure alert says: the ticket that prevented it and that nothing changed. */
  description: FailureDescription;
};

/**
 * Bulk edit state for the ticket list: the selection, the last failure or
 * confirmation, and request submission. A retry of the same selection and
 * change reuses its request ID so the core can deduplicate it. A batch applies
 * to every selected ticket or to none.
 */
export function useBulkEdit(refresh: () => Promise<void>) {
  const [selection, setSelection] = useState<string[]>([]);
  const [failure, setFailure] = useState<BulkFailure | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const lastChange = useRef<Change | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  function select(next: string[]) {
    setSelection(next);
    setFailure(null);
    lastChange.current = null;
  }

  const clearSelection = useCallback(() => {
    setSelection([]);
    setFailure(null);
    lastChange.current = null;
  }, []);

  async function submit(change: Change) {
    const payload = change.kind === "status" ? change.status : change.change;
    const key = JSON.stringify([selection, change.kind, payload]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    lastChange.current = change;
    setPending(true);
    setFailure(null);
    setNotice("");
    try {
      if (change.kind === "status")
        await client.bulkStatus(selection, change.status, requestId);
      else await client.bulkChange(selection, change.change, requestId);
      request.current = null;
      lastChange.current = null;
      setSelection([]);
      setNotice(change.summary);
      await refresh();
    } catch (reason) {
      setFailure(bulkFailure(reason, selection));
    } finally {
      setPending(false);
    }
  }

  return {
    selection,
    failure,
    notice,
    pending,
    toggle(reference: string) {
      select(
        selection.includes(reference)
          ? selection.filter((item) => item !== reference)
          : [...selection, reference],
      );
    },
    selectAll(references: string[]) {
      select([...new Set([...selection, ...references])]);
    },
    // Stable, so effects that clear the selection do not rerun on every render.
    clearSelection,
    /** Drops the selection and any pending retry, e.g. after a restore. */
    reset() {
      select([]);
      setNotice("");
      request.current = null;
    },
    applyStatus: (status: string, summary: string) =>
      submit({ kind: "status", status, summary }),
    applyOrganization: (change: BulkChange, summary: string) =>
      submit({ kind: "organization", change, summary }),
    /** Resends the failed change; the same selection reuses its request ID. */
    retry: () => (lastChange.current ? submit(lastChange.current) : undefined),
  };
}

export type BulkEdit = ReturnType<typeof useBulkEdit>;

/** Names the ticket the core rejected, when it said which operation failed. */
function bulkFailure(reason: unknown, selection: string[]): BulkFailure {
  const failure = toFailure(reason);
  const reference =
    failure.code === "batch_operation" && failure.index !== null
      ? (selection[failure.index] ?? null)
      : null;
  const detail = failure.message
    .trim()
    .replace(/^invalid batch:\s*/i, "")
    .replace(/\.$/, "");
  const retryable = failure.code !== "batch_operation";
  const described = describeFailure(
    failure,
    reference
      ? `change ${reference}`
      : `change ${selection.length} ${selection.length === 1 ? "ticket" : "tickets"}`,
  );
  return {
    retryable,
    reference,
    // The reason leads; the reassurance follows.
    message:
      reference && !detail.includes(reference)
        ? `${reference}: ${detail}. Nothing changed.`
        : `${detail}. Nothing changed.`,
    description: {
      ...described,
      // Workspace states have their own plain words; the core's reason for one
      // ticket is written for people and is said with the reassurance.
      sentence: isWorkspaceCode(failure.kind)
        ? described.sentence
        : `${sentence(detail)} Nothing changed.`,
      action: retryable ? "retry" : null,
    },
  };
}
