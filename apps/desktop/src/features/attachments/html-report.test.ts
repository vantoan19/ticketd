// @vitest-environment jsdom
import { expect, test } from "vitest";
import report from "@/test/fixtures/attachment-report.html?raw";
import { prepareReport, REPORT_CSP } from "./html-report";

/** What the frame would hold, read back as an inert document. */
function frame(srcdoc: string) {
  return new DOMParser().parseFromString(srcdoc, "text/html");
}

test("a self-contained report keeps its styles, table and embedded image", () => {
  const prepared = prepareReport(report);
  const doc = frame(prepared.srcdoc);
  expect(prepared.unusable).toBe(false);
  expect(doc.querySelector("style")?.textContent).toContain(":root");
  expect(doc.querySelectorAll("style").length).toBe(2);
  expect(doc.querySelectorAll("tbody tr")).toHaveLength(40);
  expect(
    doc.querySelector("img[alt='Pass rate']")?.getAttribute("src"),
  ).toMatch(/^data:image\/svg\+xml;base64,/);
});

test("scripts, handlers, links and the network stay off", () => {
  const prepared = prepareReport(report);
  expect(prepared.scripts).toBe(true);
  expect(prepared.external).toBe(true);
  const doc = frame(prepared.srcdoc);
  // The policy comes first, so it covers everything after it.
  const first = doc.head.firstElementChild;
  expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  expect(first?.getAttribute("content")).toBe(REPORT_CSP);
  expect(REPORT_CSP).toContain("default-src 'none'");
  expect(REPORT_CSP).toContain("img-src data:");
  expect(doc.querySelector("script")).toBeNull();
  expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(prepared.srcdoc).not.toContain("beacon");
});

test("handlers, frames, forms and a base are removed", () => {
  const prepared = prepareReport(
    `<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test/">
     <body onload="x()"><p onclick="x()">Hello</p><iframe src="https://evil.test/"></iframe>
     <object data="a.swf"></object><form action="https://evil.test/"><button formaction="https://evil.test/">Go</button></form>
     <a href="javascript:x()" target="_blank">link</a></body>`,
  );
  const doc = frame(prepared.srcdoc);
  expect(prepared.scripts).toBe(true);
  expect(doc.querySelector("base, iframe, object, embed")).toBeNull();
  expect(doc.querySelectorAll("meta[http-equiv]")).toHaveLength(1);
  expect(doc.querySelector("[onload], [onclick]")).toBeNull();
  expect(doc.querySelector("form")?.hasAttribute("action")).toBe(false);
  expect(doc.querySelector("button")?.hasAttribute("formaction")).toBe(false);
  expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(doc.querySelector("a")?.hasAttribute("target")).toBe(false);
});

test("a quiet report has no line about what is off", () => {
  const prepared = prepareReport(
    "<!doctype html><style>p{color:red}</style><p>All green</p>",
  );
  expect(prepared).toMatchObject({
    scripts: false,
    external: false,
    unusable: false,
  });
});

test("a report that renders nothing, or only stylesheets that are not here, can't show", () => {
  expect(
    prepareReport("<!doctype html><body><div id=app></div>").unusable,
  ).toBe(true);
  expect(
    prepareReport('<body><div id=app></div><script>app.innerHTML="x"</script>')
      .unusable,
  ).toBe(true);
  const unstyled = prepareReport(
    '<link rel="stylesheet" href="site.css"><p>Results</p>',
  );
  expect(unstyled.external).toBe(true);
  expect(unstyled.unusable).toBe(true);
  // Remote pictures alone leave nothing visible.
  expect(
    prepareReport('<img src="https://example.com/chart.png">').unusable,
  ).toBe(true);
  // An embedded picture is content.
  expect(
    prepareReport('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">')
      .unusable,
  ).toBe(false);
});
