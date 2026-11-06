import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./TicketWorkspaceView.tsx", import.meta.url),
  "utf8",
);

test("the saved pane layout is versioned so old 468px layouts are ignored", () => {
  expect(source).toMatch(/id: "ticketd\.workspace\.v2"/);
  expect(source).toMatch(/id="list"[\s\S]*?defaultSize=\{384\}/);
});
