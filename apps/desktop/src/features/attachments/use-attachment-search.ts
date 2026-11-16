import { useEffect, useState } from "react";
import {
  attachments,
  type AttachmentState,
  type AttachmentSearchResult,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useWorkspaceChange } from "@/lib/workspace-change";

/** Typing settles this long before the search is sent. */
const SEARCH_DELAY_MS = 150;
/** How many files one "Show 50 more" adds. */
export const ATTACHMENT_PAGE = 50;

/**
 * A pasted ticketd link ("<ticketd://attachment/{workspace}/{id}>") searches
 * for its file's id, which the core matches; anything else is searched as typed.
 */
export function searchTerm(search: string) {
  const link = /ticketd:\/\/attachment\/[^/\s>]+\/([^/\s>]+)/i.exec(search);
  return link?.[1] ? decodeURIComponent(link[1]) : search;
}

/**
 * Searches the attachment library, `limit` files from the top ("Show 50 more"
 * raises it). The rows of the last answer stay while a new search is out, so
 * typing does not blank the list: `loading` is true only before the first
 * answer, and `pending` while a newer one is on its way. `answered` is the
 * query the rows answer, for "No files match …"; `more` says the source may
 * hold files past the limit.
 */
export function useAttachmentSearch(
  search: string,
  state: AttachmentState,
  ticket: string | null,
  limit: number = ATTACHMENT_PAGE,
  refresh = 0,
  holdLiveChanges = false,
) {
  const incomingRevision = useWorkspaceChange();
  const [revision, setRevision] = useState(incomingRevision);
  // Explicit search/filter/retry still answers immediately. Only unrelated live
  // refreshes wait until the person leaves the navigator and its focused rows.
  if (!holdLiveChanges && revision !== incomingRevision)
    setRevision(incomingRevision);
  const [query, setQuery] = useState(search);
  useEffect(() => {
    if (query === search) return;
    const timer = window.setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, search]);
  const key = JSON.stringify([query, state, ticket, limit, revision, refresh]);
  const [result, setResult] = useState<{
    files: AttachmentSearchResult[];
    key: string | null;
    answered: { search: string; state: AttachmentState; limit: number };
    known: boolean;
    error: FailureDescription | null;
  }>({
    files: [],
    key: null,
    known: false,
    answered: { search, state, limit },
    error: null,
  });
  useEffect(() => {
    let current = true;
    const answered = { search: query, state, limit };
    void attachments
      .search({
        search: searchTerm(query).trim(),
        state,
        ticket,
        offset: 0,
        limit,
      })
      .then(
        (files) => {
          if (current)
            setResult({ files, key, answered, known: true, error: null });
        },
        (reason: unknown) => {
          if (current)
            setResult((previous) => ({
              ...previous,
              key,
              error: describeFailure(reason, "load files"),
            }));
        },
      );
    return () => {
      current = false;
    };
  }, [query, state, ticket, limit, key]);
  return {
    files: result.files,
    known: result.known,
    error: result.error,
    answered: result.answered,
    loading: result.key === null,
    pending: result.key !== key || query !== search,
    more: result.files.length >= result.answered.limit,
  };
}
