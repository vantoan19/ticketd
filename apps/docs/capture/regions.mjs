import {
  featureRef,
  featuredTicket,
  dependentRef,
  report,
  specTitle,
} from "../src/demo/workspace.ts";

/** Measure the controls in the real desktop window in CSS pixels, independently
 * of capture density. Each callout has both an exact target and a useful crop. */
export async function measureRegions(screen, page, size) {
  const graphTicket = (reference) =>
    page
      .locator('[data-slot="graph-node"]')
      .filter({ has: page.getByText(reference, { exact: true }) });
  const ticket = page.locator('[data-board-reference="' + featureRef + '"]');
  const exact = (words) => page.getByText(words, { exact: true }).first();
  const flow = (id) => page.locator('[data-flow-card="' + id + '"]');
  const inbox = (words) =>
    page.locator(".inbox-ticket").filter({ hasText: words });
  const targets = {
    plan: {
      ready: [graphTicket(featureRef), ".ui-graph-node-trailing"],
      waiting: [graphTicket(dependentRef), ".ui-graph-node-reason"],
      spec: [page.getByRole("button", { name: "Spec: " + specTitle })],
    },
    context: {
      purpose: [exact(featuredTicket.body)],
      subticket: [
        page
          .locator(".reference-rows")
          .getByText("Show the retry time", { exact: true })
          .first(),
      ],
    },
    board: { working: [ticket, ".board-card-title"] },
    done: { completed: [ticket, ".board-card-title"] },
    ticket: {
      update: [
        page.getByRole("button", {
          name: "Go to update: " + report,
          exact: true,
        }),
      ],
    },
    evidence: {
      verification: [
        page.locator(".evidence-item").filter({ hasText: "Boundary tests" }),
        ".evidence-item-name",
      ],
    },
    inbox: {
      review: [inbox("moved it to In review"), ".inbox-icon"],
      note: [inbox(report), ".inbox-icon"],
      earlier: [inbox("Todo → In progress"), ".inbox-icon"],
    },
    rules: { notify: [flow("notify"), ".flow-card-icon"] },
    "rules-triage": { branch: [flow("check"), ".flow-card-icon"] },
    "rules-weekly": { agent: [flow("scan"), ".flow-card-icon"] },
  };
  const entries = {};
  for (const [name, [control, part]] of Object.entries(targets[screen])) {
    let full = await control.boundingBox({ timeout: 4500 });
    const mark = part
      ? await control.locator(part).first().boundingBox({ timeout: 4500 })
      : full;
    if (!full || !mark)
      throw Error("Missing capture target " + screen + "/" + name);
    // Point to the leading edge so the label stays clear of the actual text.
    const x = Math.round(mark.x + Math.min(3, mark.width / 2)),
      y = Math.round(mark.y + Math.min(12, mark.height / 2));
    if (x < 0 || y < 0 || x >= size.width || y >= size.height)
      throw Error("Capture target outside the window: " + screen + "/" + name);
    if (screen.startsWith("rules")) {
      full = await page
        .locator("button[data-flow-card]")
        .evaluateAll((nodes) => {
          const boxes = nodes.map((n) => n.getBoundingClientRect());
          const x = Math.min(...boxes.map((b) => b.left)),
            y = Math.min(...boxes.map((b) => b.top));
          return {
            x,
            y,
            width: Math.max(...boxes.map((b) => b.right)) - x,
            height: Math.max(...boxes.map((b) => b.bottom)) - y,
          };
        });
    } else if (screen === "inbox") {
      const right = await control
        .locator(".inbox-summary")
        .evaluate((element) => {
          const text = document.createRange();
          text.selectNodeContents(element);
          return text.getBoundingClientRect().right;
        });
      full.width = Math.min(full.width, right - full.x + 12);
    }
    entries[name] = {
      x,
      y,
      left: Math.round(full.x),
      top: Math.round(full.y),
      width: Math.round(full.width),
      height: Math.round(full.height),
    };
  }
  return entries;
}
