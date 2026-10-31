import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { MarkdownEditor } from "./MarkdownEditor";

export const representativeMarkdown = `# Document editing\n\nSelect **some text** for formatting, or type / for a block. 日本語 café 🧭\n\n3. A numbered item\n   - Nested bullet\n4. Another item\n\n- [x] Completed checklist item\n- [ ] Remaining checklist item\n\n| Name | Value |\n| :--- | ---: |\n| Escaped \\| pipe | 42 |\n\n\`\`\`typescript\nconst greeting = "Hello";\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\n  Draft --> Review\n  Review --> Done\n\`\`\`\n`;
const unsupportedMarkdown = `# Source recovery\n\n<!-- Keep this comment. -->\n\n[Reference link][example]\n\n[example]: https://example.com\n\n![image description](local-image.png)\n\n<aside>Raw HTML stays in source.</aside>\n`;

/** Development-only interaction harness; never writes to a workspace. */
export function PlatePrototype() {
  const [saved, setSaved] = useState(representativeMarkdown);
  const [draft, setDraft] = useState(representativeMarkdown);
  const [baseline, setBaseline] = useState(representativeMarkdown);
  const [note, setNote] = useState("");
  const [submittedNote, setSubmittedNote] = useState("");
  const [saves, setSaves] = useState(0);
  const [submissions, setSubmissions] = useState(0);
  const [readOnly, setReadOnly] = useState(false);
  const [dark, setDark] = useState(false);
  const dirty = draft !== baseline;
  const conflict = dirty && saved !== baseline;
  useEffect(() => {
    if (!dirty || conflict) return;
    const timer = window.setTimeout(() => {
      setSaved(draft);
      setBaseline(draft);
      setSaves((count) => count + 1);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, conflict]);
  function load(source: string) {
    setSaved(source);
    setDraft(source);
    setBaseline(source);
    setSaves(0);
  }
  return (
    <main
      className={dark ? "dark" : ""}
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <div
        className="flex flex-col gap-4"
        style={{ maxWidth: 960, padding: 24, margin: "auto" }}
      >
        <h1 className="text-2xl font-semibold">Plate document prototype</h1>
        <p>
          Development surface · simulated saves · canonical Markdown. Existing
          workspace editors stay available at the normal app URL.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => load(representativeMarkdown)}
          >
            Representative fixture
          </Button>
          <Button variant="outline" onClick={() => load(unsupportedMarkdown)}>
            Unsupported fixture
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              load(
                Array.from(
                  { length: 200 },
                  (_, index) =>
                    `## Section ${index + 1}\n\nA representative paragraph with **formatting**, [a link](https://example.com), 日本語 and a checklist.\n\n- [ ] Review item ${index + 1}\n`,
                ).join("\n"),
              )
            }
          >
            Long fixture (200 sections)
          </Button>
          <Button
            variant="outline"
            aria-pressed={readOnly}
            onClick={() => setReadOnly((current) => !current)}
          >
            Read only
          </Button>
          <Button
            variant="outline"
            aria-pressed={dark}
            onClick={() => setDark((current) => !current)}
          >
            Dark theme
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const external = saved + "\nExternal update.\n";
              setSaved(external);
              if (!dirty) {
                setBaseline(external);
                setDraft(external);
              }
            }}
          >
            Simulate external refresh
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(draft + "\nLocal draft.\n");
              setSaved(saved + "\nExternal update.\n");
            }}
          >
            Simulate dirty refresh
          </Button>
        </div>
        <h2 className="text-lg font-semibold">
          Description · autosave after 500ms
        </h2>
        {conflict && (
          <Alert>
            <AlertTitle>Saved description changed</AlertTitle>
            <AlertDescription>
              Your local draft is preserved. Autosave is paused.
            </AlertDescription>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setDraft(saved);
                  setBaseline(saved);
                }}
              >
                Reload saved content
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBaseline(saved)}
              >
                Save my draft
              </Button>
            </div>
          </Alert>
        )}
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          readOnly={readOnly}
          label="Description"
        />
        <p role="status" data-testid="description-status">
          Description save requests: {saves} ·{" "}
          {conflict ? "Conflict" : dirty ? "Pending" : "Saved"} · {draft.length}{" "}
          characters
        </p>
        <details>
          <summary>Current description Markdown</summary>
          <pre
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="description-markdown"
          >
            {draft}
          </pre>
        </details>
        <h2 className="text-lg font-semibold">Note · explicit submission</h2>
        <MarkdownEditor
          value={note}
          onChange={setNote}
          readOnly={readOnly}
          label="Note"
        />
        <Button
          disabled={readOnly || !note.trim()}
          onClick={() => {
            setSubmittedNote(note);
            setSubmissions((count) => count + 1);
            setNote("");
          }}
        >
          Submit note
        </Button>
        <p role="status">Note submissions: {submissions}</p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{submittedNote}</pre>
        <p>
          Keyboard: Mod+B / Mod+I, Mod+Z / Mod+Shift+Z, Tab / Shift+Tab in
          lists; Alt+↑ / Alt+↓ moves a block. Drag the selected block grip onto
          another block.
        </p>
      </div>
    </main>
  );
}
