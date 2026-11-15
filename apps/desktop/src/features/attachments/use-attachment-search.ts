import { useEffect, useState } from "react";
import {
  attachments,
  type AttachmentState,
  type AttachmentSearchResult,
} from "@/lib/api/attachments";
import { useWorkspaceChange } from "@/lib/workspace-change";

/** Typing settles this long before the search is sent. */
const SEARCH_DELAY_MS = 150;

/**
 * Searches the attachment library. The rows of the last answer stay while a
 * new search is out, so typing does not blank the list: `loading` is true only
 * before the first answer, and `pending` while a newer one is on its way.
 * `answered` is the query the rows answer, for "No files match …".
 */
export function useAttachmentSearch(
  search: string,
  state: AttachmentState,
  ticket: string | null,
  offset: number,
  refresh = 0,
) {
  const revision = useWorkspaceChange();
  const [query, setQuery] = useState(search);
  useEffect(() => {
    if (query === search) return;
    const timer = window.setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, search]);
  const key = JSON.stringify([query, state, ticket, offset, revision, refresh]);
  const [result, setResult] = useState<{
    files: AttachmentSearchResult[];
    key: string | null;
    answered: { search: string; state: AttachmentState; offset: number };
    error: string;
  }>({
    files: [],
    key: null,
    answered: { search, state, offset },
    error: "",
  });
  useEffect(() => {
    let current = true;
    const answered = { search: query, state, offset };
    void attachments
      .search({ search: query, state, ticket, offset, limit: 50 })
      .then(
        (files) => {
          if (current) setResult({ files, key, answered, error: "" });
        },
        (reason: unknown) => {
          if (current)
            setResult({ files: [], key, answered, error: String(reason) });
        },
      );
    return () => {
      current = false;
    };
  }, [query, state, ticket, offset, key]);
  return {
    files: result.files,
    error: result.error,
    answered: result.answered,
    loading: result.key === null,
    pending: result.key !== key || query !== search,
  };
}
