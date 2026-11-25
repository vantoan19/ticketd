import type { TurnRow } from "@/features/chats/model";

/**
 * A stretch: the work between two progress notes (or a note and the turn's
 * start or end). It is one row, "Read 6 files and ran 3 commands", that opens to
 * its steps. It is `ongoing` while nothing yet follows it in a running turn.
 */
export type Stretch = {
  kind: "stretch";
  /** The key of its first row, which stays the same as more arrive. */
  key: string;
  rows: TurnRow[];
  /** "Read 6 files and ran 3 commands · 1 failed". */
  label: string;
  ongoing: boolean;
  kept?: false;
};

/** What a turn shows, in order: its notes and kept rows as they are, its work as stretches. */
export type TurnBlock = Exclude<TurnRow, { kind: "step" }> | Stretch;

/** A note and the rows a turn keeps end a stretch; everything else is work. */
const endsStretch = (row: TurnRow) =>
  row.kind === "progress" || row.kept === true;

/**
 * Groups a turn's rows into stretches between its notes. `running` says the turn
 * is still going, so the stretch at its end is the one in progress.
 */
export function stretchesOf(rows: TurnRow[], running: boolean): TurnBlock[] {
  const blocks: (TurnBlock | { work: TurnRow[] })[] = [];
  let work: TurnRow[] | undefined;
  for (const row of rows) {
    if (endsStretch(row)) {
      work = undefined;
      blocks.push(row as TurnBlock);
    } else if (work) work.push(row);
    else {
      work = [row];
      blocks.push({ work });
    }
  }
  return blocks.map((block, index): TurnBlock => {
    if (!("work" in block)) return block;
    const first = block.work[0];
    return {
      kind: "stretch",
      key: first?.key ?? "",
      rows: block.work,
      label: stretchWords(block.work),
      ongoing: running && index === blocks.length - 1,
    };
  });
}

/** "1 file", "2 files": a count with its noun. */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "6 files · 2 searches": what an Explored row and an exploring stretch both say. */
export const exploredCounts = (files: number, searches: number) =>
  `${count(files, "file")} · ${count(searches, "search", "searches")}`;

/** A ticket's reference, "T-12" or "T-AX76". */
const RECORD_REFERENCE = /^[A-Z]+-[A-Z0-9]+$/;

/** The ticketd calls that only look something up. */
const LOOKUPS = new Set(["read", "list", "search"]);

/** What the stretch did, by kind, in the order each kind began. */
type Tally = Map<string, { ids: Set<string>; extra: number }>;

/** "Read 6 files and ran 3 commands · 1 failed": every row of a stretch in one line. */
export function stretchWords(rows: TurnRow[]): string {
  const tally: Tally = new Map();
  // What changed in ticketd, by id, with the reference to name when it is alone.
  const changed = new Map<string, string | undefined>();
  const add = (kind: string, ids: string[], extra = 0) => {
    if (ids.length === 0 && extra === 0) return;
    const entry = tally.get(kind) ?? { ids: new Set<string>(), extra: 0 };
    ids.forEach((id) => entry.ids.add(id));
    entry.extra += extra;
    tally.set(kind, entry);
  };
  const note = (id: string, reference?: string) => {
    if (!tally.has("changed"))
      tally.set("changed", { ids: new Set(), extra: 0 });
    changed.set(id, reference);
  };
  let failed = 0;
  let thought = false;
  let planned = false;
  for (const row of rows) {
    if (row.kind === "reasoning") thought = true;
    else if (row.kind === "plan") planned = true;
    else if (row.kind === "record") {
      const change = row.change;
      if (change.kind === "document") note(change.document_id);
      else note(change.reference, change.reference);
    } else if (row.kind === "step") {
      const step = row.step;
      const named = (step.targets ?? []).map((target) => target.text);
      // A step with no target still counts once.
      const ids = named.length ? named : [row.key];
      if (step.state === "failed")
        failed += step.kind === "run" ? 1 : ids.length;
      if (step.ticketd?.length) {
        step.ticketd.forEach((call, index) => {
          const reference = call.words.find((word) => word.code)?.text;
          // Only a call on a record is a change or a look-up; any other (a setting,
          // an attachment destination) is just a command that ran.
          if (!reference || !RECORD_REFERENCE.test(reference))
            add("run", [`${row.key}:${index}`]);
          else if (LOOKUPS.has(call.verb))
            add("lookup", [`${row.key}:${index}:${reference}`]);
          else note(reference, reference);
        });
        continue;
      }
      if (step.explored) {
        // A merged row kept what each kind named.
        add(
          "read",
          step.explored.files.map((target) => target.text),
        );
        add(
          "search",
          step.explored.searches.map((target) => target.text),
        );
        continue;
      }
      switch (step.kind) {
        case "read":
          if (step.variant === "list") add("list", ids);
          else add("read", ids, step.omitted_files?.count ?? 0);
          break;
        case "search":
          add("search", ids);
          break;
        case "web":
          if (step.variant === "fetch") add("fetch", ids);
          else add("search", ids);
          break;
        case "edit":
        case "create":
        case "delete":
          add(step.kind, ids);
          break;
        case "run":
          // A plan is the harness's own, not a command the person would count.
          if (step.variant === "plan") planned = true;
          else add("run", [row.key]);
          break;
        case "other":
          add("other", [row.key]);
          break;
      }
    }
  }
  const total = (kind: string) => {
    const entry = tally.get(kind);
    return entry ? entry.ids.size + entry.extra : 0;
  };
  const only = (...kinds: string[]) =>
    [...tally.keys()].every((kind) => kinds.includes(kind));
  const clauses: string[] = [];
  for (const kind of tally.keys()) {
    const n = total(kind);
    switch (kind) {
      case "read":
        // Reads and searches alone are exploring, said once, as a merged row says it.
        if (only("read", "search") && tally.has("search"))
          clauses.push(
            `explored ${exploredCounts(n, total("search"))}`,
          );
        else clauses.push(`read ${count(n, "file")}`);
        break;
      case "search":
        if (!(only("read", "search") && tally.has("read")))
          clauses.push(`searched ${count(n, "time")}`);
        break;
      case "list":
        clauses.push(`listed ${count(n, "folder")}`);
        break;
      case "fetch":
        clauses.push(`fetched ${count(n, "page")}`);
        break;
      case "edit":
        clauses.push(`edited ${count(n, "file")}`);
        break;
      case "create":
        clauses.push(`created ${count(n, "file")}`);
        break;
      case "delete":
        clauses.push(`deleted ${count(n, "file")}`);
        break;
      case "run":
        clauses.push(`ran ${count(n, "command")}`);
        break;
      case "lookup":
        clauses.push(`looked up ${count(n, "record")}`);
        break;
      case "changed": {
        const [reference] = [...changed.values()];
        clauses.push(
          changed.size === 1 && reference
            ? `changed ${reference}`
            : `changed ${count(changed.size, "record")}`,
        );
        break;
      }
      case "other":
        clauses.push(`used ${count(n, "tool")}`);
        break;
    }
  }
  const shown = clauses.slice(0, 3);
  const joined =
    shown.length > 1
      ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
      : (shown[0] ?? (thought ? "thought" : planned ? "planned" : "worked"));
  const more = clauses.length > 3 ? ` · ${clauses.length - 3} more` : "";
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
  return `${sentence}${more}${failed ? ` · ${failed} failed` : ""}`;
}
