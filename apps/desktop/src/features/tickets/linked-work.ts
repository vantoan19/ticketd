import { client, type Ticket } from "@/lib/api/client";

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
  { kind: "blocked_by", label: "Blocked by" },
  { kind: "blocks", label: "Blocks" },
  { kind: "parent", label: "Parent" },
  { kind: "subticket", label: "Subtickets" },
  { kind: "related", label: "Related to" },
  { kind: "discovered_while", label: "Discovered while working on" },
  { kind: "discoveries", label: "Discovered during this work" },
  { kind: "duplicate_of", label: "Duplicate of" },
  { kind: "duplicates", label: "Duplicates" },
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
  status: string | null;
  trashed: boolean;
};

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

/** Identifies the links a ticket carries, so detail changes reload the parts fetched separately. */
export function linkSignature(ticket: Ticket) {
  return JSON.stringify([
    ticket.parent?.reference,
    ticket.children.map((item) => item.reference),
    ticket.prerequisites.map((item) => [item.reference, item.status]),
    ticket.duplicate_of,
    ticket.duplicates,
  ]);
}
