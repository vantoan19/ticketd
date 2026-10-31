import DOMPurify from "dompurify";

let queue = Promise.resolve();
let nextId = 0;

export function renderDiagram(
  source: string,
  dark: boolean,
  active: () => boolean,
) {
  const result = queue.then(async () => {
    if (!active()) return "";
    if (source.length > 20000)
      throw new Error(
        "Diagram exceeds the 20,000 character rendering limit. Edit its source to simplify it.",
      );
    // Source remains untouched. Embedded directives/frontmatter cannot replace
    // application-owned security, styles, resource limits, or renderer settings.
    if (/%%\s*\{|^\s*---(?:\r?\n|\r)/.test(source))
      throw new Error(
        "Diagram configuration directives and frontmatter are unsupported. Edit the diagram source to remove configuration.",
      );
    const { default: mermaid } = await import("mermaid");
    if (!active()) return "";
    const id = `ticketd-mermaid-${++nextId}`;
    const scratch = document.createElement("div");
    scratch.setAttribute("aria-hidden", "true");
    scratch.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;";
    document.body.append(scratch);
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
        htmlLabels: false,
        maxTextSize: 20000,
        maxEdges: 500,
        suppressErrorRendering: true,
        flowchart: { htmlLabels: false },
        secure: [
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "maxEdges",
          "suppressErrorRendering",
          "htmlLabels",
          "flowchart",
          "theme",
          "themeCSS",
          "themeVariables",
        ],
      });
      const { svg } = await mermaid.render(id, source, scratch);
      const sanitized = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: [
          "foreignObject",
          "image",
          "a",
          "script",
          "iframe",
          "object",
        ],
        RETURN_DOM_FRAGMENT: true,
      });
      // SVG styles can reference remote paint servers even without HTML or
      // executable handlers. Keep local marker/gradient references only.
      const localStyles = (css: string) =>
        css
          .replace(/@import[^;]*;?/gi, "")
          .replace(/url\(([^)]*)\)/gi, (_match, value: string) =>
            /^\s*(["']?)#[\w:.-]+\1\s*$/.test(value) ? `url(${value})` : "none",
          );
      for (const element of sanitized.querySelectorAll("*")) {
        if (element.tagName.toLowerCase() === "style")
          element.textContent = localStyles(element.textContent ?? "");
        for (const attribute of Array.from(element.attributes)) {
          if (/href$/i.test(attribute.name) && !attribute.value.startsWith("#"))
            element.removeAttribute(attribute.name);
          else if (
            /style|fill|stroke|filter|mask|clip-path|marker/i.test(
              attribute.name,
            )
          )
            element.setAttribute(attribute.name, localStyles(attribute.value));
        }
      }
      const root = sanitized.querySelector("svg");
      if (!root) throw new Error("Renderer returned no SVG");
      root.style.removeProperty("max-width");
      return root.outerHTML;
    } finally {
      scratch.remove();
    }
  });
  // Mermaid configuration is global. Include initialization and rendering in one
  // queue so another document or theme cannot change config during a render.
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}
