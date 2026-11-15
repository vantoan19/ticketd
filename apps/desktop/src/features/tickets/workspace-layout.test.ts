import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./TicketWorkspaceView.tsx", import.meta.url),
  "utf8",
);

test("the navigator layout ignores earlier saved widths and keeps Inbox and board sizes separate", () => {
  expect(source).toMatch(/id: "ticketd\.workspace\.v3"/);
  expect(source).toMatch(/id: "ticketd\.workspace\.inbox\.v1"/);
  expect(source).toMatch(/id: "ticketd\.workspace\.board\.v1"/);
  expect(source).toMatch(
    /id="list"[\s\S]*?defaultSize=\{inboxMode \? 392 : 360\}/,
  );
});
