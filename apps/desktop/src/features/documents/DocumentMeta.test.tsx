// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentMeta } from "./DocumentMeta";
import { DocumentDetails } from "./DocumentDetails";
import { formatDateTime } from "@/lib/format";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const props = {
  updatedAt: "2026-11-01T09:00:00Z",
  minutes: 4,
  storage: <span>Saved on this computer</span>,
  tags: [],
  tagsLocked: false,
  onRemoveTag: vi.fn(),
};
const row = {
  plans: [{ id: "p1", name: "Launch", archived: false, spec: true }],
  tickets: [{ reference: "T-KQ1", title: "Work", status: "In progress" }],
};

it("puts a dot before every part but the first, hidden from assistive technology", () => {
  const { container } = render(<DocumentMeta row={row} {...props} />);
  const items = [...container.querySelectorAll(".document-meta-item")];
  expect(items.map((item) => item.textContent)).toEqual(
    [
      "Spec of Launch",
      "T-KQ1",
      "Updated Nov 1",
      "4 min read",
      "Saved on this computer",
    ].map((text, index) => (index === 0 ? text : `·${text}`)),
  );
  const first = items[0]?.querySelector(".document-meta-sep");
  expect(first).toBeNull();
  for (const item of items.slice(1)) {
    expect(
      item
        .querySelector(":scope > .document-meta-sep")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  }
});

it("starts no part with a dot at the start of a line: the dot of a part on a new line is hidden", () => {
  // jsdom lays nothing out: put the third part on a second line.
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
    function (this: HTMLElement) {
      const items = [...document.querySelectorAll(".document-meta-item")];
      return items.indexOf(this) >= 2 ? 26 : 0;
    },
  );
  const { container } = render(<DocumentMeta row={row} {...props} />);
  const marked = [...container.querySelectorAll(".document-meta-item")].map(
    (item) => item.hasAttribute("data-line-start"),
  );
  // The first part and the first of the second line start a line; the others follow on a line.
  expect(marked).toEqual([true, false, true, false, false]);
});

it("keeps the words of a part as plain text with one space, so the line sets the word space", () => {
  const { container } = render(<DocumentMeta row={row} {...props} />);
  expect(
    container.querySelector(".document-meta-item button")?.textContent,
  ).toBe("Spec of Launch");
  expect(container.textContent).toContain("Updated Nov 1");
  expect(container.textContent).not.toContain("Updated  ");
});

it("shows Created and Updated in Details as a date and a time, not a weekday", () => {
  const { container } = render(
    <DocumentDetails
      document={{ origin_brief: null, origin_ticket: null, kept: false }}
      createdAt="2026-11-01T09:05:00Z"
      updatedAt="2026-11-02T17:30:00Z"
      plans={[]}
    />,
  );
  const shown = [...container.querySelectorAll("dd time")].map(
    (time) => time.textContent,
  );
  expect(shown).toEqual([
    formatDateTime("2026-11-01T09:05:00Z"),
    formatDateTime("2026-11-02T17:30:00Z"),
  ]);
  // A date and a time: more than a bare weekday.
  for (const text of shown) expect(text).toMatch(/\d.*\d/);
});
