import { client, type Relationships } from "@/lib/api/client";

/** The meaning of a link, as seen from the ticket whose detail is open. */
export type LinkKind =
  | "blocked_by"
  | "blocks"
  | "parent"
  | "subticket"
  | "related"
  | "discovered_while"
  | "discoveries"
  | "duplicate_of"
  | "duplicates";

/** Groups appear in this order. */
export const linkKinds: { kind: LinkKind; label: string }[] = [
  { kind: "parent", label: "Parent" },
  { kind: "blocked_by", label: "Blocked by" },
  { kind: "blocks", label: "Blocks" },
  { kind: "subticket", label: "Subtickets" },
  { kind: "related", label: "Related to" },
  { kind: "discovered_while", label: "Discovered while working on" },
  { kind: "discoveries", label: "Discovered during this work" },
  { kind: "duplicate_of", label: "Duplicate of" },
  { kind: "duplicates", label: "Duplicates of this ticket" },
];

export const linkLabel = (kind: LinkKind) =>
  linkKinds.find((item) => item.kind === kind)?.label ?? kind;

/** Links the Link ticket flow can add. Duplicates are marked from the actions menu. */
export type AddableKind = Exclude<LinkKind, "duplicate_of" | "duplicates">;

/** Each phrase reads as a sentence starting "This ticket …", which fixes the direction. */
export const addableKinds: { kind: AddableKind; phrase: string }[] = [
  { kind: "blocked_by", phrase: "is blocked by" },
  { kind: "blocks", phrase: "blocks" },
  { kind: "parent", phrase: "is a subticket of" },
  { kind: "subticket", phrase: "is the parent of" },
  { kind: "related", phrase: "is related to" },
  { kind: "discovered_while", phrase: "was discovered while working on" },
  { kind: "discoveries", phrase: "led to the discovery of" },
];

export type LinkRow = {
  kind: LinkKind;
  reference: string;
  title: string;
  status: string;
  trashed: boolean;
  /** Still has to be Done for a dependency on it to clear. */
  unresolved: boolean;
};

/** The kinds that come as pages; they share one offset. */
export const pagedKinds = [
  ["prerequisites", "blocked_by"],
  ["blocking", "blocks"],
  ["children", "subticket"],
  ["related", "related"],
  ["discovered_while", "discovered_while"],
  ["discoveries", "discoveries"],
  ["duplicates", "duplicates"],
] as const;

/** Where the next page of any kind starts, or null when every kind is complete. */
export function nextOffset(links: Relationships): number | null {
  const offsets = pagedKinds
    .map(([key]) => links[key].next_offset)
    .filter((value): value is number => value !== null);
  return offsets.length ? Math.max(...offsets) : null;
}

/** Adds a later page to the pages already read, without repeating a ticket. */
export function mergePage(
  known: Relationships,
  page: Relationships,
): Relationships {
  const merged = { ...known };
  for (const [key] of pagedKinds) {
    const seen = new Set(known[key].items.map((item) => item.reference));
    merged[key] = {
      items: [
        ...known[key].items,
        ...page[key].items.filter((item) => !seen.has(item.reference)),
      ],
      next_offset: page[key].next_offset,
    };
  }
  return merged;
}

/** Every link in the order the section shows them, built from one core read. */
export function linkRows(links: Relationships): LinkRow[] {
  const row = (
    kind: LinkKind,
    item: Relationships["children"]["items"][number],
  ): LinkRow => ({
    kind,
    reference: item.reference,
    title: item.title.text,
    status: item.status,
    trashed: item.trashed,
    unresolved: item.unresolved,
  });
  const single = (kind: LinkKind, item: Relationships["parent"]) =>
    item ? [row(kind, item)] : [];
  const paged = (kind: LinkKind) => {
    const entry = pagedKinds.find(([, value]) => value === kind);
    return entry ? links[entry[0]].items.map((item) => row(kind, item)) : [];
  };
  return linkKinds.flatMap(({ kind }) =>
    kind === "parent"
      ? single(kind, links.parent)
      : kind === "duplicate_of"
        ? single(kind, links.duplicate_of)
        : paged(kind),
  );
}

/** Add a link of the given meaning between `ticket` and `other`. Throws the core's reason on refusal. */
export async function addLink(
  ticket: string,
  kind: AddableKind,
  other: string,
  requestId: string,
) {
  switch (kind) {
    case "blocked_by":
      return client.changeDependency("add_dependency", other, ticket);
    case "blocks":
      return client.changeDependency("add_dependency", ticket, other);
    case "parent":
      return client.setParent(ticket, other);
    case "subticket":
      return client.setParent(other, ticket);
    case "related":
      await client.changeContextualRelationship(
        ticket,
        other,
        "related",
        true,
        requestId,
      );
      return;
    case "discovered_while":
      await client.changeContextualRelationship(
        other,
        ticket,
        "discovered",
        true,
        requestId,
      );
      return;
    case "discoveries":
      await client.changeContextualRelationship(
        ticket,
        other,
        "discovered",
        true,
        requestId,
      );
      return;
  }
}

export async function removeLink(
  ticket: string,
  kind: LinkKind,
  other: string,
  requestId: string,
) {
  switch (kind) {
    case "blocked_by":
      return client.changeDependency("remove_dependency", other, ticket);
    case "blocks":
      return client.changeDependency("remove_dependency", ticket, other);
    case "parent":
      return client.setParent(ticket, null);
    case "subticket":
      return client.detachChild(other, ticket);
    case "related":
      await client.changeContextualRelationship(
        ticket,
        other,
        "related",
        false,
        requestId,
      );
      return;
    case "discovered_while":
      await client.changeContextualRelationship(
        other,
        ticket,
        "discovered",
        false,
        requestId,
      );
      return;
    case "discoveries":
      await client.changeContextualRelationship(
        ticket,
        other,
        "discovered",
        false,
        requestId,
      );
      return;
    case "duplicate_of":
      await client.removeDuplicate(ticket, requestId);
      return;
    case "duplicates":
      await client.removeDuplicate(other, requestId);
      return;
  }
}
