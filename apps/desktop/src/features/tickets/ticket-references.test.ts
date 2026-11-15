import { expect, test } from "vitest";
import type { Paragraph, Root } from "mdast";
import { references } from "./ticket-references";

function linked(text: string) {
  const paragraph: Paragraph = {
    type: "paragraph",
    children: [{ type: "text", value: text }],
  };
  references()({ type: "root", children: [paragraph] } as Root);
  return paragraph.children.map((node) =>
    node.type === "link"
      ? `<${node.url}>`
      : node.type === "text"
        ? node.value
        : "",
  );
}

test("a [[reference]] renders as the reference, never with brackets", () => {
  // detA MK-10, detB DB-33: "[[T-FV8]]" showed its brackets around the link.
  expect(linked("See [[T-FV8]] first.")).toEqual([
    "See ",
    "<ticketd:T-FV8>",
    " first.",
  ]);
  // A lone bracket is text; a bare reference links as before.
  expect(linked("[[T-FV8 and T-FV9]]")).toEqual([
    "[[",
    "<ticketd:T-FV8>",
    " and ",
    "<ticketd:T-FV9>",
    "]]",
  ]);
});
