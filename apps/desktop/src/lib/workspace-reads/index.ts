// The interface of the workspace reads module (ADR 0013). Views import from
// here; only this folder may import @tanstack/react-query. Test helpers are in
// "./testing" and "./fake-signal" and are imported by tests only.
export { WorkspaceReads } from "./WorkspaceReads";
export { Visibility } from "./Visibility";
export {
  read,
  pagedRead,
  byOffset,
  skip,
  fillRead,
  updateRead,
  updatePagedRead,
} from "./catalog";
export type { ReadSpec, PagedReadSpec, Returned, Fill, Skip } from "./catalog";
export { useRead } from "./use-read";
export { useKnown } from "./use-known";
export { usePagedRead } from "./use-paged-read";
export type { PagedState } from "./use-paged-read";
export type { ReadState, ReadStatus } from "./read-state";
export { withCurrent } from "./read-state";
export { useWrote } from "./use-wrote";
export { useReplaced } from "./use-replaced";
export { ticketRead } from "./reads";
export { pollWorkspaceChanges } from "./change-signal";
export type { ChangeSignal } from "./change-signal";
