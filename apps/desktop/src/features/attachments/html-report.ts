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
const SVG_FETCHING = new Set(["image", "use", "feImage"]);
const NOT_TEXT = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "TITLE"]);
// A stylesheet that imports another, or draws from anything but an embedded `data:` URL.
// One lookahead past the quote and spaces, so `url("data:…")` is not read as remote.
const CSS_REMOTE = /@import|url\(\s*(?!["']?\s*(?:data:|#))/i;
const LOCAL_URL = /^\s*(?:data:|#|about:blank\s*$)/i;

function external(value: string | null): boolean {
  return value !== null && value.trim() !== "" && !LOCAL_URL.test(value);
}

/**
 * Serialising and parsing a document again does not always give the same document: text
 * inside a `<style>` or `<noscript>` can become elements (a mutation XSS payload hides a
 * `<meta http-equiv=refresh>` this way). The frame parses the markup a second time, so it is
 * stripped again until it comes out the same, leaving only the policy meta that was added.
 * Markup still changing after the last pass was never checked, so it returns `null`.
 */
export function settle(markup: string): string | null {
  let current = markup;
  for (let pass = 0; pass < 4; pass += 1) {
    const doc = new DOMParser().parseFromString(current, "text/html");
    let changed = false;
    for (const element of doc.querySelectorAll(REMOVED)) {
      if (
        element.localName === "meta" &&
        element.getAttribute("content") === REPORT_CSP
      )
        continue;
      element.remove();
      changed = true;
    }
    for (const element of doc.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
          changed = true;
        }
      }
      if (
        (element.localName === "a" || element.localName === "area") &&
        (element.hasAttribute("href") || element.hasAttribute("target"))
      ) {
        element.removeAttribute("href");
        element.removeAttribute("target");
        changed = true;
      }
      if (element.localName === "form" && element.hasAttribute("action")) {
        element.removeAttribute("action");
        changed = true;
      }
      if (element.hasAttribute("formaction")) {
        element.removeAttribute("formaction");
        changed = true;
      }
    }
    if (!changed) return current;
    current = `<!doctype html>${doc.documentElement.outerHTML}`;
  }
  return null;
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
      } else if (
        // Older markup draws from the network too: a `background` or `lowsrc` picture, and
        // an SVG `<image>`, `<use>` or filter image that points at another file.
        (name === "background" ||
          name === "lowsrc" ||
          ((name === "href" || name === "xlink:href") &&
            SVG_FETCHING.has(element.localName))) &&
        external(attribute.value)
      ) {
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
  head.prepend(csp);
  // The frame sits on white paper in either theme, so the page must read as light: a report
  // that opts into a dark scheme (`color-scheme: dark light`) and paints no background of its
  // own would otherwise draw light text on that paper. Important and last, so it wins.
  const scheme = doc.createElement("style");
  scheme.textContent = ":root{color-scheme:light !important}";
  head.append(scheme);

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
  const srcdoc = settle(`<!doctype html>${doc.documentElement.outerHTML}`);
  return {
    srcdoc: srcdoc ?? "",
    scripts,
    external: outside,
    // Empty, only stylesheets that are not part of the attachment, or markup that never settled.
    unusable:
      srcdoc === null || !visible || (stylesheets && !styled && outside),
  };
}
