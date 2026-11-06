// @vitest-environment jsdom
import mermaid from "mermaid";
import { expect, test } from "vitest";
import { mermaidConfig } from "./mermaid-renderer";

// The real Mermaid, not a mock: an option it rejects or a diagram it cannot
// parse under the application's configuration must fail here, not in the app.
for (const dark of [false, true]) {
  test(`the ${dark ? "dark" : "light"} renderer config initializes and parses a flowchart`, async () => {
    mermaid.initialize(mermaidConfig(dark));
    await expect(
      mermaid.parse("graph TD; Cart-->Pay-->Receipt"),
    ).resolves.toBeTruthy();
    const applied = mermaid.mermaidAPI.getConfig();
    expect(applied.look).toBe("classic");
    expect(applied.layout).toBe("dagre");
    expect(applied.flowchart?.useMaxWidth).toBe(false);
    expect(applied.flowchart?.rankSpacing).toBe(36);
    expect(applied.theme).toBe(dark ? "dark" : "neutral");
  });
}
