/**
 * Prepares a stored HTML report for the viewer's isolated frame. The frame is
 * sandboxed without scripts or the app's origin and inherits the app's content
 * security policy; this adds two more layers so a report can never reach the
 * network, another attachment (`attachment-media:`) or a link target:
 *
 * - a leading CSP that admits only inline styles and `data:` images and fonts
 *   (policies intersect, so a report cannot loosen it), and
 * - removal of scripts, event handlers, links, forms, frames and `<base>`, so
 *   nothing in the report navigates or runs (links do nothing in the preview).
 *
 * The report is parsed with `DOMParser`, which never runs scripts.
 */
export const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export type PreparedReport = {
  /** The document to put in the frame. */
  srcdoc: string;
  /** The report had scripts, which stay off. */
  scripts: boolean;
  /** The report points at files or pages that are not part of the attachment. */
  external: boolean;
  /** Nothing visible would show, or it depends on stylesheets that are not here. */
  unusable: boolean;
};

const REMOVED =
  "script, base, link, meta[http-equiv], iframe, frame, frameset, object, embed";
const MEDIA = "svg, canvas, video, audio, table, hr, input, button, textarea";
const NOT_TEXT = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "TITLE"]);
// A stylesheet that imports another, or draws from anything but an embedded `data:` URL.
// One lookahead past the quote and spaces, so `url("data:…")` is not read as remote.
const CSS_REMOTE = /@import|url\(\s*(?!["']?\s*(?:data:|#))/i;
const LOCAL_URL = /^\s*(?:data:|#|about:blank\s*$)/i;

function external(value: string | null): boolean {
  return value !== null && value.trim() !== "" && !LOCAL_URL.test(value);
}

export function prepareReport(source: string): PreparedReport {
  const doc = new DOMParser().parseFromString(source, "text/html");
  let scripts = doc.querySelector("script") !== null;
  let outside = false;
  let stylesheets = false;
  for (const link of doc.querySelectorAll("link[rel~='stylesheet' i]")) {
    stylesheets = true;
    if (external(link.getAttribute("href"))) outside = true;
  }
  const styled =
    doc.querySelector("style") !== null ||
    doc.querySelector("[style]") !== null;
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        scripts = true;
        element.removeAttribute(attribute.name);
      } else if (name === "href" && /^\s*javascript:/i.test(attribute.value)) {
        scripts = true;
      } else if (
        (name === "src" ||
          name === "srcset" ||
          name === "poster" ||
          name === "data") &&
        external(attribute.value)
      ) {
        outside = true;
      } else if (name === "style" && CSS_REMOTE.test(attribute.value)) {
        outside = true;
      }
    }
    if (element.localName === "style" && CSS_REMOTE.test(element.textContent)) {
      outside = true;
    }
    // Links do nothing here; Open covers anything interactive.
    if (element.localName === "a" || element.localName === "area") {
      element.removeAttribute("href");
      element.removeAttribute("target");
    }
    if (element.localName === "form") element.removeAttribute("action");
    if (element.hasAttribute("formaction"))
      element.removeAttribute("formaction");
  }
  for (const element of doc.querySelectorAll(REMOVED)) element.remove();

  const head = doc.head;
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", REPORT_CSP);
  // The frame reads as a light page unless the report asks otherwise, in either theme.
  const scheme = doc.createElement("style");
  scheme.textContent = ":root{color-scheme:light}";
  head.prepend(csp, scheme);

  const body = doc.body;
  let text = false;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && !text; node = walker.nextNode())
    text =
      (node.textContent ?? "").trim() !== "" &&
      !NOT_TEXT.has(node.parentElement?.tagName ?? "");
  const picture = [...body.querySelectorAll("img")].some(
    (image) =>
      !external(image.getAttribute("src")) && image.hasAttribute("src"),
  );
  const visible = text || picture || body.querySelector(MEDIA) !== null;
  return {
    srcdoc: `<!doctype html>${doc.documentElement.outerHTML}`,
    scripts,
    external: outside,
    // Empty, or only stylesheets that are not part of the attachment.
    unusable: !visible || (stylesheets && !styled && outside),
  };
}
