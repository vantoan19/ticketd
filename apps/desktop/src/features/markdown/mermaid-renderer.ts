import DOMPurify from "dompurify";
import type { MermaidConfig } from "mermaid";

/** One stuck render must not leave every later diagram on its skeleton. */
const RENDER_TIMEOUT_MS = 10000;
function withTimeout<T>(work: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Diagram rendering timed out. Check its source in the editor.",
          ),
        ),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    look: "classic",
    layout: "dagre",
    securityLevel: "strict",
    theme: dark ? "dark" : "neutral",
    themeVariables: {
      fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
      fontSize: "14px",
      // White boxes with a grey outline and a grey line (board F).
      ...(dark
        ? {}
        : {
            primaryColor: "#ffffff",
            mainBkg: "#ffffff",
            nodeBorder: "#cccccc",
            primaryBorderColor: "#cccccc",
            lineColor: "#4d4d4d",
          }),
    },
    htmlLabels: false,
    maxTextSize: 20000,
    maxEdges: 500,
    suppressErrorRendering: true,
    // 40 px boxes on a 76 px pitch (board F).
    flowchart: {
      htmlLabels: false,
      padding: 10.9,
      rankSpacing: 36,
      minNodeWidth: 108,
      nodeSpacing: 50,
      useMaxWidth: false,
    },
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "look",
      "layout",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
      "flowchart",
      "theme",
      "themeCSS",
      "themeVariables",
    ],
  };
}

/** A module fetch that fails while the app is still settling gets two more tries. */
async function loadMermaid() {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await import("mermaid")).default;
    } catch (reason) {
      if (attempt >= 2) throw reason;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

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
    // Image nodes may fetch during Mermaid's layout, before output sanitation.
    if (/\b(?:img|image)\s*:|!\[[^\]]*\]\s*\(/i.test(source))
      throw new Error(
        "Diagrams with external resources are unsupported. Remove image resources to render locally.",
      );
    const mermaid = await loadMermaid();
    if (!active()) return "";
    const id = `ticketd-mermaid-${++nextId}`;
    const scratch = document.createElement("div");
    scratch.setAttribute("aria-hidden", "true");
    scratch.style.cssText =
      "position:absolute;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none;";
    document.body.append(scratch);
    try {
      mermaid.initialize(mermaidConfig(dark));
      const { svg } = await withTimeout(
        mermaid.render(id, source, scratch),
        RENDER_TIMEOUT_MS,
      );
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
      const width = Number(root.getAttribute("viewBox")?.split(/[ ,]+/)[2]);
      if (Number.isFinite(width) && width > 0) root.style.width = `${width}px`;
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
