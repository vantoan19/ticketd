import { useCallback, useEffect, useRef, useState } from "react";
import { client, type BulkChange, type TicketMetadata } from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { read, skip, useRead } from "@/lib/workspace-reads";

const NOTICE_MS = 4000;
// How many tickets one metadata read names: the core's page limit.
const PER_READ = 100;

type SelectedTicket = Pick<TicketMetadata, "status" | "plan_id">;

/**
 * The Status and Plan of each selected ticket by reference, whether it is listed
 * or not and wherever the filters put it now. Like every read it is read again
 * after each change and own write, so the bulk menus count the whole selection
 * (list B-04). A ticket gone to the Trash is left out.
 */
const selectionRead = read({
  key: "bulk-selection",
  call: async (references: string[]) => {
    const found: Record<string, SelectedTicket> = {};
    for (let start = 0; start < references.length; start += PER_READ) {
      const page = await client.findTicketMetadataByReference(
        references.slice(start, start + PER_READ),
      );
      for (const { reference, status, plan_id } of page)
        found[reference] = { status, plan_id };
    }
    return found;
  },
  failure: "count the selected tickets",
});

/** The selected tickets as last read, by reference; undefined until read. */
export function useSelectedTickets(selection: string[]) {
  return useRead(selectionRead, selection.length > 0 ? selection : skip).value;
}

type Change =
  | { kind: "status"; status: string; summary: string }
  | { kind: "organization"; change: BulkChange; summary: string };

export type BulkFailure = {
  /** The ticket that prevented the batch, when the core named one. */
  reference: string | null;
  /** False when the core rejected the batch itself; sending it again fails the same way. */
  retryable: boolean;
  /** Public copy and diagnostic Details, with certainty only for rejected batches. */
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
  const described = describeFailure(
    failure,
    reference
      ? `change ${reference}`
      : `change ${selection.length} ${selection.length === 1 ? "ticket" : "tickets"}`,
  );
  const retryable =
    failure.code !== "batch_operation" && described.action === "retry";
  return {
    retryable,
    reference,
    description: {
      ...described,
      // Only a structured batch rejection confirms that no operation ran.
      // Transport failures can lose the reply after commit; the same ID is safe to retry.
      sentence:
        failure.code === "batch_operation"
          ? "The batch was rejected. Nothing changed. Open Details to review the reason."
          : `${described.sentence} The selection is kept.`,
      action: retryable ? "retry" : null,
    },
  };
}
