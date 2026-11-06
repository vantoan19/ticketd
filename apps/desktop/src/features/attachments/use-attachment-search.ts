import { useEffect, useState } from "react";
import {
  attachments,
  type AttachmentState,
  type AttachmentSearchResult,
} from "@/lib/api/attachments";
import { useWorkspaceChange } from "@/lib/workspace-change";

export function useAttachmentSearch(
  search: string,
  state: AttachmentState,
  ticket: string | null,
  offset: number,
  refresh = 0,
) {
  const revision = useWorkspaceChange();
  const key = JSON.stringify([
    search,
    state,
    ticket,
    offset,
    revision,
    refresh,
  ]);
  const [result, setResult] = useState<{
    files: AttachmentSearchResult[];
    key: string | null;
    error: string;
  }>({ files: [], key: null, error: "" });
  useEffect(() => {
    let current = true;
    void attachments.search({ search, state, ticket, offset, limit: 50 }).then(
      (files) => {
        if (current) setResult({ files, key, error: "" });
      },
      (reason: unknown) => {
        if (current) setResult({ files: [], key, error: String(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, [search, state, ticket, offset, key]);
  return result.key === key
    ? { ...result, loading: false }
    : { files: [], error: "", loading: true };
}
