// The interface of the workspace reads module (ADR 0013). Views import from
// here; only this folder may import @tanstack/react-query. Test helpers are in
// "./testing" and "./fake-signal" and are imported by tests only.
export { WorkspaceReads } from "./WorkspaceReads";
export { Visibility } from "./Visibility";
export { read, pagedRead, skip } from "./catalog";
export type { ReadSpec, PagedReadSpec, Returned, Skip } from "./catalog";
export { useRead } from "./use-read";
export { usePagedRead } from "./use-paged-read";
export type { PagedState } from "./use-paged-read";
export type { ReadState, ReadStatus } from "./read-state";
export { useWrote } from "./use-wrote";
export { ticketRead } from "./reads";
export { pollWorkspaceChanges } from "./change-signal";
export type { ChangeSignal } from "./change-signal";
