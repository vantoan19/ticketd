// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import report from "@/test/fixtures/attachment-report.html?raw";
import { prepareReport, REPORT_CSP, settle } from "./html-report";

/** What the frame would hold, read back as an inert document. */
function frame(srcdoc: string) {
  return new DOMParser().parseFromString(srcdoc, "text/html");
}

test("a self-contained report keeps its styles, table and embedded image", () => {
  const prepared = prepareReport(report);
  const doc = frame(prepared.srcdoc);
  expect(prepared.unusable).toBe(false);
  expect(doc.querySelector("style")?.textContent).toContain("margin: 24px");
  expect(doc.querySelectorAll("style").length).toBe(2);
  expect(doc.querySelectorAll("tbody tr")).toHaveLength(40);
  expect(
    doc.querySelector("img[alt='Pass rate']")?.getAttribute("src"),
  ).toMatch(/^data:image\/svg\+xml;base64,/);
});

test("a report that asks for a dark scheme still reads as a light page on the white frame", () => {
  const prepared = prepareReport(
    "<!doctype html><style>:root{color-scheme:dark light}</style><meta name='color-scheme' content='dark'><h1>Dark aware</h1>",
  );
  const doc = frame(prepared.srcdoc);
  // Ours is the last rule in the head and important, so the report's own cannot undo it.
  const last = doc.head.lastElementChild;
  expect(last?.localName).toBe("style");
  expect(last?.textContent).toBe(":root{color-scheme:light !important}");
});

test("markup that turns into a refresh, a frame or a handler when parsed again is stripped again", () => {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
  const settled = settle(
    `<!doctype html><html><head>${csp}<meta http-equiv="refresh" content="0;url=https://example.com"></head>` +
      `<body><p onclick="x()">a<a href="https://example.com" target="_blank">l</a></p><iframe src="https://example.com"></iframe></body></html>`,
  );
  if (settled === null) throw new Error("the markup did not settle");
  const doc = frame(settled);
  expect(doc.querySelectorAll("meta[http-equiv]")).toHaveLength(1);
  expect(
    doc.querySelector("meta[http-equiv]")?.getAttribute("http-equiv"),
  ).toBe("Content-Security-Policy");
  expect(doc.querySelector("iframe")).toBeNull();
  expect(doc.querySelector("p")?.hasAttribute("onclick")).toBe(false);
  expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  // Markup that is already clean comes back as it was.
  expect(settle(settled)).toBe(settled);
});

test("markup that is still changing after the last pass is not trusted", () => {
  const parse = DOMParser.prototype.parseFromString;
  // Every parse brings a handler back, so no pass ever finds the markup clean.
  const spy = vi
    .spyOn(DOMParser.prototype, "parseFromString")
    .mockImplementation(function (this: DOMParser, text, type) {
      const doc = parse.call(this, text, type);
      doc.body.setAttribute("onclick", "x()");
      return doc;
    });
  try {
    expect(settle("<!doctype html><p>a</p>")).toBeNull();
    const prepared = prepareReport("<p>text</p>");
    expect(prepared.srcdoc).toBe("");
    expect(prepared.unusable).toBe(true);
  } finally {
    spy.mockRestore();
  }
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

test("a stylesheet's embedded data: URLs are local, whatever the quoting, and anything else is not", () => {
  const style = (css: string) =>
    prepareReport(`<style>${css}</style><p>hi</p>`).external;
  for (const local of [
    'a { background: url("data:image/png;base64,AAAA") }',
    "a { background: url('data:image/png;base64,AAAA') }",
    "a { background: url(data:image/png;base64,AAAA) }",
    "a { background: url( data:image/png;base64,AAAA ) }",
    "a { fill: url(#gradient) }",
  ])
    expect(style(local), local).toBe(false);
  for (const remote of [
    '@import "https://example.com/a.css";',
    'a { background: url("https://example.com/a.png") }',
    "a { background: url( https://example.com/a.png ) }",
    "a { background: url(attachment-media://x) }",
  ])
    expect(style(remote), remote).toBe(true);
});

test("older remote pictures (a background, lowsrc, an SVG image or use) count as online images", () => {
  const remote = [
    `<body background="https://example.com/paper.png"><p>Hi</p>`,
    `<p>Hi</p><table><tr><td background="//example.com/cell.gif">x</td></tr></table>`,
    `<p>Hi</p><img src="data:image/gif;base64,R0lGOD" lowsrc="https://example.com/low.gif">`,
    `<p>Hi</p><svg width="9" height="9"><image href="https://example.com/a.png"/></svg>`,
    `<p>Hi</p><svg width="9" height="9"><image xlink:href="https://example.com/a.png"/></svg>`,
    `<p>Hi</p><svg width="9" height="9"><use href="https://example.com/s.svg#a"/></svg>`,
  ];
  for (const markup of remote)
    expect(prepareReport(markup).external, markup).toBe(true);
  // Pictures that are part of the file, and a link to a spot in it, are not remote.
  const local = [
    `<body background="data:image/gif;base64,R0lGOD"><p>Hi</p>`,
    `<p>Hi</p><svg width="9" height="9"><defs><g id="a"/></defs><use href="#a"/><image href="data:image/gif;base64,R0lGOD"/></svg>`,
    `<p>Hi</p><a href="https://example.com">link</a>`,
  ];
  for (const markup of local)
    expect(prepareReport(markup).external, markup).toBe(false);
});
