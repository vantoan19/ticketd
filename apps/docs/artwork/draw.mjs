// Technical drawings for the landing page: oblique projection, ink linework, 1-bit dither shading,
// one accent for live signals. Colors come from CSS classes so both themes work:
//   .x-i ink stroke, .x-k ink fill, .x-p paper fill, .x-q second paper fill, .x-a accent fill, .x-sa accent stroke.
// Drawing primitives from the approved landing-page design. Build-time only.
import artwork from "../src/FactoryArtwork.markup.json" with { type: "json" };
const DV = [0.52, -0.3]; // one unit of depth on screen: back and to the right
const r1 = (n) => Math.round(n * 10) / 10;
const pt = (p) => r1(p[0]) + " " + r1(p[1]);
const add = (p, d) => [p[0] + DV[0] * d, p[1] + DV[1] * d];
const poly = (pts, cls, extra) =>
  `<path class="${cls}" d="M${pts.map(pt).join("L")}Z"${extra || ""}></path>`;
const line = (a, b, cls, w) =>
  `<path class="${cls}" d="M${pt(a)}L${pt(b)}" stroke-width="${w || 1}" fill="none"></path>`;

// Ordered dither (Bayer 4x4) as patterns d1..d15: n of 16 cells filled, 2-unit cells, ink colored.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
function defs() {
  const pats = [1, 2, 4, 6, 8, 10, 12, 14].map((n) => {
    let d = "";
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        if (BAYER[y][x] < n) d += `M${x * 2} ${y * 2}h2v2h-2z`;
    return `<pattern id="d${n}" width="8" height="8" patternUnits="userSpaceOnUse"><path class="x-k" d="${d}"></path></pattern>`;
  });
  const hatch = `<pattern id="hz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)"><path class="x-i" d="M0 0V6" stroke-width="1"></path></pattern>`;
  const grid = `<pattern id="bpgrid" width="20" height="20" patternUnits="userSpaceOnUse"><path class="x-sa" d="M20 0H0V20" stroke-width="0.5" fill="none" opacity="0.35"></path></pattern>`;
  const arw = `<marker id="x-arw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="x-k" d="M0 1L8 4L0 7Z"></path></marker>`;
  const term = `<marker id="x-term" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse"><rect class="x-p x-i" x="0.5" y="0.5" width="7" height="7" stroke-width="1"></rect></marker>`;
  return `<svg class="x-defs" width="0" height="0" aria-hidden="true" style="position:absolute"><defs>${pats.join("")}${hatch}${grid}${arw}${term}</defs></svg>`;
}

// A box seen from the front, its top and right side receding. y is the top of the front face.
function box(o) {
  const { x, y, w, h, d } = o;
  const f = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const t = [[x, y], [x + w, y], add([x + w, y], d), add([x, y], d)];
  const s = [
    [x + w, y],
    add([x + w, y], d),
    add([x + w, y + h], d),
    [x + w, y + h],
  ];
  const sw = o.sw || 1.4;
  let g = "";
  const face = (pts, fill, pat) =>
    poly(pts, fill) +
    (pat ? poly(pts, "x-pat", ` style="fill:url(#${pat})"`) : "");
  g += face(t, o.topFill || "x-p", o.top === undefined ? "d2" : o.top);
  g += face(s, o.sideFill || "x-p", o.side === undefined ? "d8" : o.side);
  g += face(f, o.front || "x-p", o.frontPat || null);
  g +=
    poly(t, "x-i x-n", ` stroke-width="${sw}"`) +
    poly(s, "x-i x-n", ` stroke-width="${sw}"`) +
    poly(f, "x-i x-n", ` stroke-width="${sw}"`);
  return `<g${o.cls ? ` class="${o.cls}"` : ""}>${g}</g>`;
}

// The dithered shadow a box throws on the floor, down and to the left.
function shadow(x, y, w, d, len) {
  const L = len || 14;
  const pts = [
    [x - L, y + L * 0.55],
    [x + w - L, y + L * 0.55],
    add([x + w - L, y + L * 0.55], d),
    add([x - L, y + L * 0.55], d),
  ];
  return poly(pts, "x-pat", ' style="fill:url(#d6)"');
}

const rect = (x, y, w, h, cls, extra) =>
  `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"${extra || ""}></rect>`;
const circ = (x, y, r, cls, extra) =>
  `<circle class="${cls}" cx="${r1(x)}" cy="${r1(y)}" r="${r1(r)}"${extra || ""}></circle>`;
const text = (x, y, s, size, cls, anchor) =>
  `<text class="${cls || "x-t"}" x="${r1(x)}" y="${r1(y)}" font-size="${size || 9}"${anchor ? ` text-anchor="${anchor}"` : ""}>${s}</text>`;
function vents(x, y, w, h, n) {
  let g = "";
  const step = w / n;
  for (let i = 0; i < n; i++)
    g += rect(x + i * step + step * 0.3, y, step * 0.38, h, "x-k");
  return g;
}
function screws(x, y, w, h, inset) {
  const i = inset || 5;
  return [
    [x + i, y + i],
    [x + w - i, y + i],
    [x + i, y + h - i],
    [x + w - i, y + h - i],
  ]
    .map((p) => circ(p[0], p[1], 1.6, "x-p x-i", ' stroke-width="1"'))
    .join("");
}
function leds(x, y, n, on, cls) {
  let g = "";
  for (let i = 0; i < n; i++)
    g += circ(
      x + i * 9,
      y,
      2.6,
      (i === on ? "x-a" : "x-p") + " x-i" + (cls ? " " + cls + "-" + i : ""),
      ' stroke-width="1"',
    );
  return g;
}
function display(x, y, w, h, lines, cls) {
  let g = rect(x, y, w, h, "x-k");
  lines.forEach((s, i) => {
    g += text(x + 6, y + 13 + i * 12, s, 9.5, i === 0 ? "x-tp" : "x-ta");
  });
  return `<g${cls ? ` class="${cls}"` : ""}>${g}</g>`;
}
function panel(x, y, w, h) {
  return rect(x, y, w, h, "x-i x-n", ' stroke-width="1"');
}

// A roller seen end-on on the front face.
const roller = (x, y, r) =>
  circ(x, y, r, "x-p x-i", ' stroke-width="1.2"') + circ(x, y, r * 0.35, "x-k");

// A belt conveyor along x: frame, rollers, a moving belt texture on top, legs.
function conveyor(o) {
  const { x, y, len, d } = o;
  const h = o.h || 9;
  let g = "";
  if (o.legs !== false)
    for (let i = 0; i <= len; i += o.legGap || 120) {
      const lx = Math.min(x + i, x + len - 8);
      g += box({
        x: lx,
        y: y + h,
        w: 6,
        h: o.legH || 26,
        d: 6,
        top: null,
        side: "d8",
        sw: 1,
      });
    }
  g += box({ x, y, w: len, h, d, top: null, side: "d10", sw: 1.4 });
  // Belt texture: ribs across the belt, animated by dash offset.
  const ribs = [];
  for (let i = 6; i < len; i += 10)
    ribs.push(`M${pt([x + i, y])}L${pt(add([x + i, y], d))}`);
  g += `<path class="x-i x-belt${o.cls ? " " + o.cls : ""}" d="${ribs.join("")}" stroke-width="0.8" fill="none"></path>`;
  for (let i = 7; i < len; i += 16) g += roller(x + i, y + h / 2 + 0.5, 3.6);
  return `<g>${g}</g>`;
}

// A ticket lying on a belt, with an upright tag carrying its reference.
function ticket(x, y, ref, o) {
  const opt = o || {};
  const w = opt.w || 30;
  const d = opt.d || 22;
  const t = [[x, y], [x + w, y], add([x + w, y], d), add([x, y], d)];
  let g =
    poly(t, opt.accent ? "x-a" : "x-p") +
    poly(t, "x-i x-n", ' stroke-width="1.1"');
  const lx = add([x + 6, y], d * 0.4);
  g +=
    line(lx, add([x + 18, y], d * 0.4), opt.accent ? "x-ip" : "x-i", 1.2) +
    line(
      add([x + 6, y], d * 0.7),
      add([x + 14, y], d * 0.7),
      opt.accent ? "x-ip" : "x-i",
      1.2,
    );
  const tx = x + w * 0.5;
  g +=
    rect(tx - 15, y - 21, 30, 13, "x-p x-i", ' stroke-width="1"') +
    text(tx, y - 11.5, ref, 8.5, "x-t", "middle") +
    line([tx, y - 8], [tx, y + 1], "x-i", 1);
  return `<g${opt.cls ? ` class="${opt.cls}"` : ""}>${g}</g>`;
}

// A small hairline label with a leader line to what it names.
function tag(x, y, s, to, o) {
  const opt = o || {};
  const w = s.length * 6.3 + 16;
  let g = "";
  if (to)
    g +=
      `<path class="x-i" d="M${pt([opt.right ? x : x + w, y + 7])}L${pt(to)}" stroke-width="0.9" fill="none"></path>` +
      circ(to[0], to[1], 2, "x-k");
  g +=
    rect(x, y, w, 17, "x-p x-i", ' stroke-width="1"') +
    text(x + 8, y + 12.5, s, 10.5, "x-t");
  return `<g class="x-tag${opt.cls ? " " + opt.cls : ""}">${g}</g>`;
}

// Halftone sphere: square dots sized by how far each point faces away from the light.
function sphere(cx, cy, R, o) {
  const opt = o || {};
  const g = opt.grid || 5;
  const L = [-0.55, -0.7, 0.45];
  const ln = Math.hypot(...L);
  let dots = "";
  for (let py = cy - R; py <= cy + R; py += g) {
    for (let px = cx - R; px <= cx + R; px += g) {
      const dx = (px - cx) / R;
      const dy = (py - cy) / R;
      const rr = dx * dx + dy * dy;
      if (rr > 1) continue;
      const nz = Math.sqrt(1 - rr);
      const lit = Math.max(0, (dx * L[0] + dy * L[1] + nz * L[2]) / ln);
      // Latitude bands add structure, like the windings of a coil.
      const band = Math.abs(Math.sin(Math.asin(dy) * 7)) < 0.18 ? 0.25 : 0;
      const shade = Math.min(1, 1 - lit * 0.95 + band);
      const s = Math.round(shade * shade * (g - 0.5) * 2) / 2;
      if (s >= 0.5)
        dots += `M${r1(px - s / 2)} ${r1(py - s / 2)}h${s}v${s}h-${s}z`;
    }
  }
  return (
    circ(cx, cy, R, "x-p") +
    `<path class="x-k" d="${dots}"></path>` +
    circ(cx, cy, R, "x-i x-n", ' stroke-width="1.6"')
  );
}

// A robot arm in side view: base, two links, round joints, a gripper. Angles in degrees.
function arm(o) {
  const { x, y } = o;
  let g = "";
  // Base: a squat drum.
  g += `<ellipse class="x-p x-i" cx="${x}" cy="${y}" rx="34" ry="10" stroke-width="1.4"></ellipse>`;
  g +=
    rect(x - 34, y - 26, 68, 26, "x-p") +
    `<path class="x-pat" d="M${x - 34} ${y - 26}h68v26h-68z" style="fill:url(#d4)"></path>`;
  g += `<path class="x-i x-n" d="M${x - 34} ${y}V${y - 26}M${x + 34} ${y}V${y - 26}" stroke-width="1.4"></path>`;
  g += `<ellipse class="x-p x-i" cx="${x}" cy="${y - 26}" rx="34" ry="10" stroke-width="1.4"></ellipse>`;
  for (let i = -2; i <= 2; i++) g += circ(x + i * 12, y - 12, 2.2, "x-k");
  const sh = [x, y - 40];
  const a1 = (o.a1 * Math.PI) / 180;
  const a2 = (o.a2 * Math.PI) / 180;
  const el = [sh[0] + Math.cos(a1) * o.l1, sh[1] + Math.sin(a1) * o.l1];
  const wr = [el[0] + Math.cos(a2) * o.l2, el[1] + Math.sin(a2) * o.l2];
  const link = (a, b, wdt) => {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const nx = (-Math.sin(ang) * wdt) / 2;
    const ny = (Math.cos(ang) * wdt) / 2;
    const pts = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ];
    const shade = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] + nx * 0.2, b[1] + ny * 0.2],
      [a[0] + nx * 0.2, a[1] + ny * 0.2],
    ];
    const slot = [
      [
        a[0] + (b[0] - a[0]) * 0.25 - nx * 0.35,
        a[1] + (b[1] - a[1]) * 0.25 - ny * 0.35,
      ],
      [
        a[0] + (b[0] - a[0]) * 0.75 - nx * 0.35,
        a[1] + (b[1] - a[1]) * 0.75 - ny * 0.35,
      ],
    ];
    return (
      poly(pts, "x-p") +
      poly(shade, "x-pat", ' style="fill:url(#d6)"') +
      poly(pts, "x-i x-n", ' stroke-width="1.4"') +
      line(slot[0], slot[1], "x-i", 2.4)
    );
  };
  const joint = (p, r) =>
    circ(p[0], p[1], r, "x-p x-i", ' stroke-width="1.4"') +
    circ(p[0], p[1], r, "x-pat", ' style="fill:url(#d4)"') +
    circ(p[0], p[1], r * 0.42, "x-a x-i", ' stroke-width="1"');
  g += link(sh, el, 20) + link(el, wr, 15);
  g += joint(sh, 15) + joint(el, 12);
  // Gripper.
  const ga = Math.atan2(wr[1] - el[1], wr[0] - el[0]);
  const gx = Math.cos(ga);
  const gy = Math.sin(ga);
  const px = -gy;
  const py = gx;
  const g1 = [wr[0] + px * 7 + gx * 14, wr[1] + py * 7 + gy * 14];
  const g2 = [wr[0] - px * 7 + gx * 14, wr[1] - py * 7 + gy * 14];
  g += rect(
    wr[0] - 7,
    wr[1] - 7,
    14,
    14,
    "x-k",
    ` transform="rotate(${r1((ga * 180) / Math.PI)} ${r1(wr[0])} ${r1(wr[1])})"`,
  );
  g +=
    line([wr[0] + px * 7, wr[1] + py * 7], g1, "x-i", 3) +
    line([wr[0] - px * 7, wr[1] - py * 7], g2, "x-i", 3);
  return { svg: `<g${o.cls ? ` class="${o.cls}"` : ""}>${g}</g>`, wrist: wr };
}

// The cat: a grey pixel tabby, 28 x 23 pixels, drawn at s units per pixel with its feet at (x, y + 23 s).
function cat(x, y, s, o) {
  const opt = o || {};
  // Feet stay where a 23-row cat's would: the hat adds rows on top.
  return `<g class="x-cat${opt.cls ? " " + opt.cls : ""}" transform="translate(${r1(x)} ${r1(y - 2 * s)}) scale(${s})" shape-rendering="crispEdges">${artwork.cat}</g>`;
}

function cable(a, b, cls, bend) {
  const k = bend || 0.5;
  const c1 = [a[0] + (b[0] - a[0]) * k, a[1]];
  const c2 = [a[0] + (b[0] - a[0]) * (1 - k), b[1]];
  return (
    `<path class="${cls}" d="M${pt(a)}C${pt(c1)} ${pt(c2)} ${pt(b)}" fill="none"></path>` +
    rect(a[0] - 3, a[1] - 3, 6, 6, "x-p x-i", ' stroke-width="1"') +
    rect(b[0] - 3, b[1] - 3, 6, 6, "x-p x-i", ' stroke-width="1"')
  );
}

// A numbered callout: a balloon at `at` with a leader to the dot it names at `to`.
function callout(n, at, to) {
  return `<g class="x-co">${line(at, to, "x-i", 0.9)}${circ(to[0], to[1], 1.9, "x-k")}${circ(at[0], at[1], 8.5, "x-p x-i", ' stroke-width="1.1"')}${text(at[0], at[1] + 3.3, String(n), 9.5, "x-t", "middle")}</g>`;
}

// A riveted nameplate on a front face.
function plate(x, y, w, h, s, o) {
  const opt = o || {};
  let g = rect(
    x,
    y,
    w,
    h,
    opt.dark ? "x-k" : "x-p x-i",
    opt.dark ? "" : ' stroke-width="1"',
  );
  g +=
    circ(x + 3.5, y + h / 2, 1.3, opt.dark ? "x-p" : "x-k") +
    circ(x + w - 3.5, y + h / 2, 1.3, opt.dark ? "x-p" : "x-k");
  g += text(
    x + w / 2,
    y + h / 2 + (opt.size || 7) * 0.36,
    s,
    opt.size || 7,
    opt.dark ? "x-tp" : "x-t2",
    "middle",
  );
  return g;
}

// A round gauge: ticks over 240 degrees and a needle; `cls` names the needle so a page can turn it.
function gauge(cx, cy, r, value, o) {
  const opt = o || {};
  let g =
    circ(cx, cy, r + 2.5, "x-p x-i", ' stroke-width="1.2"') +
    circ(cx, cy, r, "x-i x-n", ' stroke-width="0.8"');
  for (let i = 0; i <= 10; i++) {
    const a = ((-120 + i * 24) * Math.PI) / 180;
    const inner = r - (i % 5 === 0 ? 5.5 : 3);
    g += line(
      [cx + Math.sin(a) * inner, cy - Math.cos(a) * inner],
      [cx + Math.sin(a) * (r - 0.8), cy - Math.cos(a) * (r - 0.8)],
      "x-i",
      i % 5 === 0 ? 1.3 : 0.8,
    );
  }
  if (opt.label)
    g += text(
      cx,
      cy + r * 0.5 + 2,
      opt.label,
      Math.max(5.5, r * 0.26),
      "x-t2",
      "middle",
    );
  const deg = -120 + value * 240;
  g += `<g class="x-needle${opt.cls ? " " + opt.cls : ""}" style="transform-origin: ${r1(cx)}px ${r1(cy)}px; transform: rotate(var(--needle, ${r1(deg)}deg))">${line([cx, cy + 3], [cx, cy - r + 5], "x-sa", 1.8)}</g>`;
  return g + circ(cx, cy, 2.6, "x-k");
}

// A lamp: a lens in a bezel; `cls` lets the page light it.
function lamp(cx, cy, r, cls) {
  return (
    circ(cx, cy, r + 2, "x-p x-i", ' stroke-width="1"') +
    circ(
      cx,
      cy,
      r,
      `x-p x-i x-lamp${cls ? " " + cls : ""}`,
      ' stroke-width="1"',
    )
  );
}

// Hex bolts in the corners of a face.
function bolts(x, y, w, h, inset) {
  const i = inset || 6;
  return [
    [x + i, y + i],
    [x + w - i, y + i],
    [x + i, y + h - i],
    [x + w - i, y + h - i],
  ]
    .map(
      (p) =>
        circ(p[0], p[1], 2.2, "x-p x-i", ' stroke-width="1"') +
        line([p[0] - 1.2, p[1]], [p[0] + 1.2, p[1]], "x-i", 0.8),
    )
    .join("");
}

// Hazard stripes filling a rectangle.
function stripes(x, y, w, h, o) {
  const opt = o || {};
  const step = opt.step || 8;
  let s = "";
  for (let k = -h; k < w; k += step * 2)
    s += `M${r1(x + k)} ${r1(y + h)}L${r1(x + k + h)} ${r1(y)}L${r1(x + k + h + step)} ${r1(y)}L${r1(x + k + step)} ${r1(y + h)}Z`;
  return (
    `<svg x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" viewBox="${r1(x)} ${r1(y)} ${r1(w)} ${r1(h)}" overflow="hidden">${rect(x, y, w, h, "x-p")}<path class="x-k" d="${s}"></path></svg>` +
    rect(x, y, w, h, "x-i x-n", ' stroke-width="1"')
  );
}

// A pipe through points: a thick ink line with a paper core and collars at the corners.
function pipe(pts, o) {
  const opt = o || {};
  const w = opt.w || 6;
  const d = "M" + pts.map(pt).join("L");
  let g = `<path class="x-i" d="${d}" stroke-width="${w}" fill="none" stroke-linejoin="round"></path><path class="x-ip" d="${d}" stroke-width="${w - 2.4}" fill="none" stroke-linejoin="round"></path>`;
  pts.slice(1, -1).forEach((p) => {
    g += rect(
      p[0] - w / 2 - 1.5,
      p[1] - w / 2 - 1.5,
      w + 3,
      w + 3,
      "x-p x-i",
      ' stroke-width="1"',
    );
  });
  return `<g${opt.cls ? ` class="${opt.cls}"` : ""}>${g}</g>`;
}

// A knob seen face-on: a scale of detents round it and a pointer; `cls` names the part that turns.
function knob(cx, cy, r, o) {
  const opt = o || {};
  const n = opt.detents || 5;
  const span = opt.span || 240;
  let g = "";
  for (let i = 0; i < n; i++) {
    const a = ((-span / 2 + (span / (n - 1)) * i) * Math.PI) / 180;
    g += line(
      [cx + Math.sin(a) * (r + 4), cy - Math.cos(a) * (r + 4)],
      [cx + Math.sin(a) * (r + 8), cy - Math.cos(a) * (r + 8)],
      "x-i",
      1.2,
    );
  }
  g += circ(cx, cy, r + 1.5, "x-k");
  g += `<g class="x-knob${opt.cls ? " " + opt.cls : ""}" style="transform-origin: ${r1(cx)}px ${r1(cy)}px">${circ(cx, cy, r, "x-p x-i", ' stroke-width="1.2"')}${circ(cx, cy, r, "x-pat", ' style="fill:url(#d2)"')}<path class="x-k" d="M${r1(cx - r * 0.22)} ${r1(cy + r * 0.55)}L${r1(cx - r * 0.12)} ${r1(cy - r * 0.92)}L${r1(cx + r * 0.12)} ${r1(cy - r * 0.92)}L${r1(cx + r * 0.22)} ${r1(cy + r * 0.55)}Z"></path>${circ(cx, cy - r * 0.7, 1.6, "x-p")}</g>`;
  if (opt.label) g += text(cx, cy + r + 18, opt.label, 7.5, "x-t2", "middle");
  return g;
}

export {
  DV,
  add,
  poly,
  line,
  defs,
  box,
  shadow,
  rect,
  circ,
  text,
  vents,
  screws,
  leds,
  display,
  panel,
  roller,
  conveyor,
  ticket,
  tag,
  sphere,
  arm,
  cat,
  cable,
  pt,
  r1,
  callout,
  plate,
  gauge,
  lamp,
  bolts,
  stripes,
  pipe,
  knob,
};
