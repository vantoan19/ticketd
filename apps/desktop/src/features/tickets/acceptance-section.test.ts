import { expect, test } from "vitest";
import { acceptanceSection } from "./acceptance-section";

test("counts the Acceptance criteria checklist up to the next peer heading", () => {
  const acceptance =
    "## Acceptance criteria\n\n- [x] Ship it\n- [ ] Verify it\n\n";
  const prefix = "# Summary\n\n- [x] Before the section\n\n";
  const markdown =
    prefix + acceptance + "## Related work\n\n- [x] After the section";
  const section = acceptanceSection(markdown);

  expect(section).toEqual({
    start: prefix.length,
    end: markdown.indexOf("## Related work"),
    done: 1,
    total: 2,
  });
});

test("recognizes How would you know it worked? in a Setext heading", () => {
  const markdown =
    "How would you *know* it worked?\n--------\n\n1. [X] Verified";
  expect(acceptanceSection(markdown)).toEqual({
    start: 0,
    end: markdown.length,
    done: 1,
    total: 1,
  });
});

test("includes deeper headings and nested checklist items until a higher-level heading", () => {
  const markdown = [
    "### Acceptance",
    "",
    "- [x] Confirmed",
    "  - [ ] Nested check",
    "",
    "#### On a second device",
    "",
    "* [X] Also confirmed",
    "* An ordinary list item",
    "",
    "## Notes",
    "",
    "- [x] Outside the section",
  ].join("\n");

  expect(acceptanceSection(markdown)).toEqual({
    start: 0,
    end: markdown.indexOf("## Notes"),
    done: 2,
    total: 3,
  });
});

test("keeps the first acceptance section even when it has no checklist items", () => {
  const markdown = [
    "## Acceptance notes",
    "",
    "Verify that the ticket opens.",
    "",
    "## Acceptance criteria",
    "",
    "- [x] It opens",
  ].join("\n");

  expect(acceptanceSection(markdown)).toEqual({
    start: 0,
    end: markdown.indexOf("## Acceptance criteria"),
    done: 0,
    total: 0,
  });
});

test("returns no section when only examples contain an acceptance heading", () => {
  const markdown = [
    "# Summary",
    "",
    "- [x] Reviewed",
    "",
    "```markdown",
    "## Acceptance criteria",
    "- [ ] Example",
    "```",
    "",
    "> ## How would you know it worked?",
    "> - [ ] Quoted example",
  ].join("\n");

  expect(acceptanceSection(markdown)).toBeNull();
});
