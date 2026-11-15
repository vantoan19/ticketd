import { useEffect, useEffectEvent, useState } from "react";
import { FileText, Folder } from "lucide-react";
import { ChoiceList, type ChoiceGroup } from "@/components/ui/choice-list";
import { StatusIcon } from "./StatusIcon";

/** A ticket, Document or Project offered by a RecordPicker. */
export type PickRecord =
  | {
      kind: "ticket";
      /** Unique within the picker, such as "ticket:T-KQ1". */
      key: string;
      reference: string;
      title: string;
      status: string;
      caption?: string;
    }
  | {
      kind: "document" | "project";
      key: string;
      title: string;
      caption?: string;
    };

/** A titled group of records: "Linked to this ticket", "Recent", or results. */
export type RecordGroup = { heading?: string; records: PickRecord[] };

const DELAY_MS = 150;

/**
 * Finds tickets, Documents or Projects by name (DESIGN.md section 11, P3),
 * for `#` mentions, Link popovers, Plan context and the editor's Link. One
 * search row ("Search {things} by title or reference"), then the groups
 * `search` returns: with nothing typed, "Linked to this …" and "Recent";
 * once typing, the results. 36px rows: StatusIcon and reference for a
 * ticket, a page or folder icon otherwise, a truncating title and a trailing
 * caption. Typing is debounced by 150ms; a failure shows above the rows.
 *
 * The caller owns the data: `search` is the host's record search, the
 * Documents API, or anything that answers a query with groups.
 */
export function RecordPicker({
  search,
  onPick,
  things,
  exclude = [],
  empty,
  autoFocus = true,
  rows = 6,
}: {
  search: (query: string) => Promise<RecordGroup[]>;
  onPick: (record: PickRecord) => void;
  /** What is searched, for the placeholder and the list name: "Documents". */
  things: string;
  /** Keys already chosen; they are not offered again. */
  exclude?: readonly string[];
  /** The empty row's words for a query ("" while nothing is typed). */
  empty?: (query: string) => string;
  autoFocus?: boolean;
  rows?: number;
}) {
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<RecordGroup[]>([]);
  const [error, setError] = useState("");
  const find = useEffectEvent(search);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(
      () => {
        find(query.trim()).then(
          (found) => {
            if (!current) return;
            setGroups(found);
            setError("");
          },
          (reason: unknown) => {
            if (current) setError(`Search failed: ${String(reason)}`);
          },
        );
      },
      query ? DELAY_MS : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  const byKey = new Map(
    groups.flatMap((group) => group.records).map((r) => [r.key, r]),
  );
  const shown: ChoiceGroup[] = groups.map((group) => ({
    ...(group.heading && { heading: group.heading }),
    choices: group.records
      .filter((record) => !exclude.includes(record.key))
      .map((record) => ({
        value: record.key,
        label: record.title,
        ...(record.kind === "ticket" && { reference: record.reference }),
        icon:
          record.kind === "ticket" ? (
            <StatusIcon status={record.status} decorative />
          ) : record.kind === "document" ? (
            <FileText aria-hidden="true" />
          ) : (
            <Folder aria-hidden="true" />
          ),
        ...(record.caption && { meta: record.caption }),
      })),
  }));
  return (
    <ChoiceList
      label={things}
      searchPlaceholder={`Search ${things} by title or reference`}
      autoFocus={autoFocus}
      query={query}
      onQueryChange={setQuery}
      size="tall"
      rows={rows}
      groups={shown}
      onSelect={(key) => {
        const record = byKey.get(key);
        if (record) onPick(record);
      }}
      {...(error && { notice: error })}
      empty={
        empty ??
        ((text) => (text ? `No ${things} match “${text}”` : `No ${things} yet`))
      }
    />
  );
}
