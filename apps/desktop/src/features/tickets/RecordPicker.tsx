import { failureText } from "@/lib/api/describe-failure";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
type RecordGroup<Record> = { heading?: string; records: Record[] };

type SearchResult<Record> = {
  groups: RecordGroup<Record>[];
  empty?: ReactNode;
};

type SearchResponse<Record> =
  | { result: SearchResult<Record>; error?: never }
  | { error: string; result?: never };

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
export function RecordPicker<Record extends PickRecord>({
  search,
  onPick,
  things,
  exclude = [],
  empty,
  autoFocus = true,
  rows = 6,
  revision = 0,
}: {
  search: (query: string) => Promise<SearchResult<Record>>;
  onPick: (record: Record) => void;
  /** What is searched, for the placeholder and the list name: "Documents". */
  things: string;
  /** Keys already chosen; they are not offered again. */
  exclude?: readonly string[];
  /** The empty row's words for a query ("" while nothing is typed). */
  empty?: (query: string, hasMatches: boolean) => ReactNode;
  autoFocus?: boolean;
  rows?: number;
  revision?: number;
}) {
  const [query, setQuery] = useState("");
  const request = useMemo(
    () => ({ query, things, revision }),
    [query, things, revision],
  );
  const [answer, setAnswer] = useState<{
    request: typeof request;
    response: SearchResponse<Record>;
  }>();
  const find = useEffectEvent(search);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(
      () => {
        find(request.query.trim()).then(
          (found) => {
            if (!current) return;
            setAnswer({ request, response: { result: found } });
          },
          (reason: unknown) => {
            if (current)
              setAnswer({
                request,
                response: {
                  error: failureText(reason, `search ${request.things}`),
                },
              });
          },
        );
      },
      request.query ? DELAY_MS : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [request]);
  const response = answer?.request === request ? answer.response : undefined;
  const result = response?.result;
  const groups = result?.groups ?? [];
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
      notice={
        !response ? (
          <span role="status">Searching…</span>
        ) : response.error ? (
          <span role="alert">{response.error}</span>
        ) : undefined
      }
      empty={
        result
          ? (text) =>
              result.empty ??
              empty?.(text, byKey.size > 0) ??
              (text ? `No ${things} match “${text}”` : `No ${things} yet`)
          : null
      }
    />
  );
}
