// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, expect, it } from "vitest";
import { Card } from "@/components/ui/card";
import { EventRow, Timeline } from "@/components/ui/timeline";

afterEach(cleanup);

it("lists events and cards as items of one list, the badge icon hidden from the name", () => {
  render(
    <Timeline aria-label="Activity">
      <EventRow icon={Bell} meta="· codex · now">
        Status Open → Done
      </EventRow>
      <li>
        <Card>An update</Card>
      </li>
    </Timeline>,
  );
  const items = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toBe("Status Open → Done· codex · now");
  expect(items[0]!.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
});
