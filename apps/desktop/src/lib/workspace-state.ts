import { useSyncExternalStore } from "react";

/** The workspace-level states the band reports (the core's workspace failure kinds). */
export type WorkspaceProblem =
  | "workspace_read_only"
  | "workspace_unreadable"
  | "workspace_locked"
  | "disk_full"
  /** Unsaved drafts could not be protected for another reason. */
  | "drafts_unprotected";

export type WorkspaceState = {
  problem: WorkspaceProblem;
  /** The raw cause, shown only under Details. */
  details: string;
} | null;

let state: WorkspaceState = null;
const listeners = new Set<() => void>();

function publish(next: WorkspaceState) {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Records a workspace-level failure from any command. The band shows the
 * latest one until recovery proves writes work again.
 */
export function reportWorkspaceFailure(
  problem: WorkspaceProblem,
  details: string,
) {
  const failure = { problem, details };
  publish(failure);
  return failure;
}

/** Capture the failure an async recovery attempt is allowed to clear. */
export function getWorkspaceFailure(): WorkspaceState {
  return state;
}

/** A completed recovery must not clear a failure reported since it began. */
export function clearWorkspaceFailure(expected: WorkspaceState = state) {
  if (state === expected) publish(null);
}

/**
 * A command succeeded. A lock is transient (another operation finished), so
 * any success ends it; the other states wait for Retry, because reads still
 * succeed on a read-only or full workspace.
 */
export function noteWorkspaceSuccess() {
  if (state?.problem === "workspace_locked") publish(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current workspace-level problem, or null while the workspace is fine. */
export function useWorkspaceState(): WorkspaceState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Why editing controls are disabled, for their tooltip; null while editing works. */
export function editingBlockedReason(current: WorkspaceState): string | null {
  switch (current?.problem) {
    case "workspace_read_only":
      return "This workspace is read-only.";
    case "workspace_locked":
      return "Another ticketd operation is using this workspace.";
    case "disk_full":
      return "The disk is full.";
    case "workspace_unreadable":
      return "ticketd can't read this workspace.";
    case "drafts_unprotected":
    case undefined:
      return null;
  }
}
