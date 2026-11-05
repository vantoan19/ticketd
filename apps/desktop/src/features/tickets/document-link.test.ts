import { expect, test } from "vitest";
import { withoutDocumentLink } from "./document-link";

const link = "[Plan](ticketd://document/doc-1)";

test("unlinking drops the line that only introduced the link", () => {
  expect(withoutDocumentLink(`Notes\n\nDocument: ${link}\n`, "doc-1")).toBe(
    "Notes\n",
  );
  expect(withoutDocumentLink(`${link}\n`, "doc-1")).toBe("");
});

test("unlinking keeps the words of a link inside a sentence", () => {
  expect(withoutDocumentLink(`See ${link} first`, "doc-1")).toBe(
    "See Plan first\n",
  );
});
