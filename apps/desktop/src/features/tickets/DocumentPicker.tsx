import { useRef, useState } from "react";
import { documents, type DocumentSummary } from "@/features/documents/api";
import { RecordPicker, type PickRecord } from "./RecordPicker";

/**
 * Find a Document by title: the RecordPicker scoped to Documents. With
 * nothing typed it lists the most recent ones under "Recent", so picking
 * never requires knowing an ID; an Activity detail shows its update as the
 * caption.
 */
export function DocumentPicker({
  onPick,
  exclude = [],
  autoFocus = true,
  includeSupport = false,
}: {
  onPick: (document: DocumentSummary) => void;
  /** Document IDs already chosen; they are not offered again. */
  exclude?: string[];
  autoFocus?: boolean;
  /** Also offer Activity details, which are Documents that support a ticket. */
  includeSupport?: boolean;
}) {
  const found = useRef(new Map<string, DocumentSummary>());
  // Everything on offer is already chosen, which is not the same as nothing existing.
  const [allChosen, setAllChosen] = useState(false);
  // A pick clears the search: the linked Document leaves the list, so a kept
  // query would only show "No Documents match".
  const [picks, setPicks] = useState(0);
  return (
    <RecordPicker
      key={picks}
      things="Documents"
      autoFocus={autoFocus}
      exclude={exclude}
      search={async (query) => {
        const list = query
          ? await documents.search(query, null, 0, includeSupport)
          : await documents.recent(0, includeSupport);
        for (const item of list) found.current.set(item.id, item);
        setAllChosen(
          !query &&
            list.length > 0 &&
            list.every((item) => exclude.includes(item.id)),
        );
        const records: PickRecord[] = list.map((item) => ({
          kind: "document",
          key: item.id,
          title: item.heading,
          ...(item.origin_ticket && {
            caption: `${item.origin_ticket} · Update details`,
          }),
        }));
        return [{ ...(!query && { heading: "Recent" }), records }];
      }}
      onPick={(record) => {
        const document = found.current.get(record.key);
        if (!document) return;
        onPick(document);
        setPicks((count) => count + 1);
      }}
      empty={(query) =>
        query
          ? `No Documents match “${query}”`
          : allChosen
            ? "All Documents are already linked"
            : "No Documents yet"
      }
    />
  );
}
