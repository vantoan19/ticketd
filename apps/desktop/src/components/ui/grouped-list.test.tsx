// @vitest-environment jsdom
import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GroupHeader, PagedGroupBody } from "./grouped-list";
import {
  useGroupFolds,
  useGroupedListFocus,
  usePagedGroup,
} from "./use-grouped-list";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("names the group header with its count and reports when it folds", () => {
  function List() {
    const [open, setOpen] = useState(true);
    return (
      <GroupHeader
        label="Open tickets"
        count={3}
        open={open}
        onOpenChange={setOpen}
        roving={{
          "data-grouped-list-item": "",
          "aria-keyshortcuts": "",
          tabIndex: 0,
          onFocus: () => {},
          onKeyDown: () => {},
        }}
      />
    );
  }
  render(<List />);
  const heading = screen.getByRole("heading", { name: "Open tickets 3" });
  const button = within(heading).getByRole("button", {
    name: "Open tickets 3",
    expanded: true,
  });
  fireEvent.click(button);
  expect(within(heading).getByRole("button", { expanded: false })).toBe(button);
});

it("remembers a folded group when the list is opened again on this computer", () => {
  function List({ list }: { list: "documentGroups" | "fileGroups" }) {
    const folds = useGroupFolds(list);
    return (
      <button
        aria-expanded={folds.isOpen("open-tickets")}
        onClick={() => folds.setOpen("open-tickets", false)}
      >
        Open tickets
      </button>
    );
  }
  const files = render(<List list="fileGroups" />);
  fireEvent.click(screen.getByRole("button", { expanded: true }));
  files.unmount();
  const documents = render(<List list="documentGroups" />);
  expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
  documents.unmount();
  render(<List list="fileGroups" />);
  expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
});

function PagedList({
  readPage,
  total,
}: {
  readPage: (offset: number) => Promise<string[]>;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const page = usePagedGroup({
    open,
    readPage,
    revision: 0,
    loadAction: "load Finished work",
    pageSize: 2,
    total,
  });
  return (
    <section aria-label="Finished work">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Finished work
      </button>
      <PagedGroupBody page={page} noun="files" loadingText="Loading files…">
        {(rows) => (
          <ul>
            {rows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        )}
      </PagedGroupBody>
    </section>
  );
}

it("reads a closed group only when opened and lets that group retry a failed read", async () => {
  const readPage = vi
    .fn<(offset: number) => Promise<string[]>>()
    .mockRejectedValueOnce(new Error("busy"))
    .mockResolvedValue(["Shipped report"]);
  render(<PagedList readPage={readPage} total={1} />);
  const group = screen.getByRole("region", { name: "Finished work" });
  expect(readPage).not.toHaveBeenCalled();
  fireEvent.click(within(group).getByRole("button", { name: "Finished work" }));
  const error = await within(group).findByRole("alert");
  expect(error.textContent).toContain("load Finished work");
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  expect((await within(group).findByRole("listitem")).textContent).toBe(
    "Shipped report",
  );
  expect(within(group).queryByRole("alert")).toBeNull();
});

it("appends pages and offers only the number of rows left to read", async () => {
  const readPage = async (offset: number) =>
    offset === 0 ? ["Issue screenshots", "Acceptance report"] : ["Deploy log"];
  render(<PagedList readPage={readPage} total={3} />);
  fireEvent.click(screen.getByRole("button", { name: "Finished work" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Show 1 more files" }),
  );
  await screen.findByText("Deploy log");
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    ["Issue screenshots", "Acceptance report", "Deploy log"],
  );
  expect(
    screen.queryByRole("button", { name: /Show more|Show \d+ more/ }),
  ).toBeNull();
});

it("moves the list's single tab stop through headers and rows", () => {
  function List() {
    const root = useRef<HTMLDivElement>(null);
    const roving = useGroupedListFocus(
      root,
      ["open", "report", "finished"],
      "documents-move",
    );
    return (
      <div ref={root}>
        <GroupHeader
          label="Open tickets"
          count={1}
          open
          onOpenChange={() => {}}
          roving={roving.item("open")}
        />
        <button {...roving.item("report")}>Issue report</button>
        <GroupHeader
          label="Finished work"
          count={1}
          open={false}
          onOpenChange={() => {}}
          roving={roving.item("finished")}
        />
      </div>
    );
  }
  render(<List />);
  const open = screen.getByRole("button", { name: "Open tickets 1" });
  const report = screen.getByRole("button", { name: "Issue report" });
  const finished = screen.getByRole("button", { name: "Finished work 1" });
  const move = (from: HTMLElement, key: string, to: HTMLElement) => {
    fireEvent.keyDown(from, { key });
    expect(document.activeElement).toBe(to);
    expect(
      screen.getAllByRole("button").filter((button) => button.tabIndex === 0),
    ).toEqual([to]);
  };
  fireEvent.focus(open);
  move(open, "ArrowDown", report);
  move(report, "j", finished);
  move(finished, "k", report);
  move(report, "ArrowUp", open);
  move(open, "End", finished);
  move(finished, "Home", open);
});
