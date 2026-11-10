// Rebuild the static, trusted SVG parts with `npm run artwork -w @ticketd/docs`.
// React supplies labels and interaction state; no generated markup handles input.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { hero } from "./hero.mjs";
import {
  box,
  shadow,
  rect,
  circ,
  text,
  line,
  plate,
  bolts,
  vents,
  conveyor,
  cat,
  gauge,
  knob,
  pipe,
  poly,
  lamp,
  roller,
} from "./draw.mjs";

function paper(x, y, w, h) {
  let s = box({ x, y, w, h, d: 7, top: "d1", side: "d6", sw: 1 });
  s += rect(x + 8, y + 11, w - 16, 15, "fp-paper-label");
  for (let i = 0; i < 4; i++) {
    s += line(
      [x + 10, y + 37 + i * 8],
      [x + w - 10 - (i % 3) * 9, y + 37 + i * 8],
      "x-i",
      0.75,
    );
  }
  s += rect(x + 10, y + h - 19, w - 20, 10, "x-p x-i", ' stroke-width=".6"');
  return s;
}

function archiveDrawer(open) {
  let s = box({
    x: 0,
    y: 0,
    w: 91,
    h: 46,
    d: open ? 28 : 3,
    top: open ? "d4" : null,
    side: open ? "d10" : null,
    sw: 1,
  });
  s += rect(9, 7, 73, 15, "fp-drawer-label x-i", ' stroke-width=".75"');
  s += rect(30, 29, 30, 5, "x-k") + rect(34, 30, 22, 2, "x-p");
  s += circ(7, 35, 1.4, "x-k") + circ(84, 35, 1.4, "x-k");
  return s;
}

function archive() {
  let s = pipe(
    [
      [92, 78],
      [92, 48],
      [746, 48],
      [746, 86],
    ],
    { w: 5 },
  );
  s += box({
    x: 457,
    y: 68,
    w: 286,
    h: 12,
    d: 20,
    top: "d1",
    side: "d8",
    sw: 1.2,
  });
  for (let x = 475; x < 730; x += 24) s += circ(x, 74, 1.4, "x-k");
  s += plate(505, 71, 162, 7, "TICKETD WORKS · CONTEXT TRANSFER", {
    size: 4.8,
  });
  s += shadow(65, 361, 328, 72, 14);
  for (const x of [77, 348])
    s += box({
      x,
      y: 349,
      w: 22,
      h: 20,
      d: 27,
      top: null,
      side: "d8",
      sw: 1.2,
    });
  s += box({
    x: 65,
    y: 96,
    w: 328,
    h: 251,
    d: 72,
    top: "d2",
    side: "d10",
    sw: 1.6,
  });
  s += box({
    x: 54,
    y: 338,
    w: 352,
    h: 16,
    d: 78,
    top: "d4",
    side: "d10",
    sw: 1.2,
  });
  s += plate(79, 108, 213, 24, "THE CONTEXT ARCHIVE", { size: 11 });
  s += plate(305, 108, 73, 24, "CT–03", { dark: true, size: 10 });
  s += rect(80, 144, 297, 171, "x-k");
  const labels = [
    ["SPEC", "DECISIONS", "PLAN"],
    ["RESEARCH", "NOTES", "UPDATE"],
    ["HISTORY", "LINKS", "PROOF"],
  ];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const label = labels[r][c];
      if (["SPEC", "NOTES", "UPDATE", "PROOF"].includes(label)) continue;
      s += `<g transform="translate(${86 + c * 97} ${150 + r * 54})">${archiveDrawer(false)}${text(45.5, 17, label, 7.5, "x-t2", "middle")}</g>`;
    }
  s +=
    vents(88, 323, 174, 5, 24) +
    plate(291, 320, 86, 12, "REUSE · DO NOT COPY", { size: 5.3 });
  s += bolts(65, 96, 328, 251, 6);
  s += poly(
    [
      [404, 118],
      [422, 108],
      [422, 276],
      [404, 286],
    ],
    "x-p x-i",
    ' stroke-width="1"',
  );
  for (let y = 133; y < 260; y += 12)
    s += line([409, y], [417, y - 4], "x-i", 2);
  s += poly(
    [
      [409, 292],
      [420, 286],
      [420, 307],
      [409, 313],
    ],
    "x-k",
  );
  // Suspended source reader, its rail, clamp, and selector console.
  s += box({
    x: 454,
    y: 273,
    w: 121,
    h: 64,
    d: 32,
    top: "d2",
    side: "d8",
    sw: 1.3,
  });
  s += rect(465, 284, 54, 37, "x-p x-i");
  s += text(471, 297, "LINKS", 8, "x-t2");
  s += knob(547, 303, 12, { detents: 4, cls: "fp-source-knob" });
  s += paper(460, 132, 100, 132);
  s += rect(480, 126, 34, 11, "x-k") + rect(484, 128, 26, 3, "x-p");
  s += line([504, 81], [504, 125], "x-i", 3) + circ(504, 89, 4, "x-p x-i");
  s += line([510, 82], [510, 125], "x-i", 1);
  s += conveyor({
    x: 424,
    y: 350,
    len: 698,
    d: 46,
    h: 12,
    legH: 28,
    legGap: 155,
    cls: "fp-packing-belt",
  });
  s += box({
    x: 620,
    y: 243,
    w: 112,
    h: 95,
    d: 42,
    top: "d2",
    side: "d10",
    sw: 1.4,
  });
  s += box({
    x: 609,
    y: 234,
    w: 135,
    h: 12,
    d: 48,
    top: "d4",
    side: "d8",
    sw: 1.3,
  });
  s += plate(630, 256, 90, 16, "CONTEXT PACKER", { size: 7.6 });
  s += gauge(651, 301, 17, 1, { label: "PACK", cls: "fp-pack-gauge" });
  s += vents(687, 283, 26, 25, 5) + bolts(620, 243, 112, 95, 6);
  s += plate(629, 324, 92, 7, "SOURCE → TICKET CONTEXT", { size: 4.2 });
  s += lamp(702, 317, 3.5, "fp-ready-lamp");
  s += cat(758, 305, 1.9);
  // Bearings, lower return belt, calibration marks, conduit sockets.
  s += pipe(
    [
      [438, 337],
      [438, 379],
      [726, 379],
    ],
    { w: 4 },
  );
  for (let x = 446; x < 1120; x += 12)
    s += line([x, 365], [x, x % 24 === 0 ? 371 : 368], "x-i", 0.6);
  s += plate(644, 365, 130, 12, "MANIFEST / SOURCE REFERENCES", { size: 5.3 });
  s += line([41, 389], [1157, 389], "x-i", 0.7);
  s +=
    line([46, 394], [213, 394], "x-i", 0.5) +
    line([1031, 394], [1157, 394], "x-i", 0.5);

  const packetBack =
    shadow(0, 341, 112, 48, 12) +
    box({ x: 0, y: 279, w: 112, h: 59, d: 48, top: "d4", side: "d8", sw: 1.5 });
  let packetFront = box({
    x: 9,
    y: 280,
    w: 94,
    h: 58,
    d: 0,
    top: null,
    side: null,
    sw: 1.1,
  });
  packetFront += plate(16, 296, 81, 18, "", { size: 12 });
  packetFront +=
    line([16, 326], [97, 326], "x-i", 1) + bolts(9, 280, 94, 58, 4);
  for (let k = 0; k < 3; k++)
    packetFront += rect(23 + k * 22, 331, 14, 3, "x-k");
  return {
    body: s,
    drawerClosed: archiveDrawer(false),
    drawerOpen: archiveDrawer(true),
    packetBack,
    packetFront,
    packetPaper: paper(26, 225, 64, 83),
  };
}

function assistant() {
  let s = "";
  // Heavy workbench: cross braces, bolted legs, adjustable feet and service conduit.
  s += shadow(75, 301, 1040, 55, 14);
  for (const x of [86, 372, 778, 1085]) {
    s += box({
      x,
      y: 243,
      w: 12,
      h: 58,
      d: 16,
      top: null,
      side: "d8",
      sw: 1.2,
    });
    s += box({
      x: x - 4,
      y: 298,
      w: 23,
      h: 5,
      d: 22,
      top: "d4",
      side: "d10",
      sw: 1,
    });
  }
  s +=
    line([98, 289], [366, 255], "x-i", 2) +
    line([382, 255], [772, 289], "x-i", 2);
  s += pipe(
    [
      [95, 279],
      [1102, 279],
      [1102, 191],
    ],
    { w: 5 },
  );
  s += box({
    x: 75,
    y: 238,
    w: 1040,
    h: 15,
    d: 55,
    top: "d2",
    side: "d10",
    sw: 1.5,
  });
  s += plate(465, 241, 233, 9, "TICKETD WORKS / ASSISTANT BENCH · AS–04", {
    size: 5.2,
  });
  for (let x = 91; x < 1108; x += 37) s += circ(x, 246, 1.8, "x-p x-i");
  // Source file magazine with index tabs, roller feed, lamp and mechanical counter.
  s += box({
    x: 91,
    y: 123,
    w: 213,
    h: 107,
    d: 47,
    top: "d4",
    side: "d10",
    sw: 1.4,
  });
  s += rect(102, 138, 189, 58, "x-k");
  s += plate(106, 207, 132, 14, "SOURCE READER / T-12", { size: 7.1 });
  s += vents(311, 153, 13, 39, 4) + bolts(91, 123, 213, 107, 5);
  s += lamp(267, 214, 4, "fp-reader-lamp");
  for (let x = 112; x < 288; x += 22) s += roller(x, 192, 5);
  // Adjustable task lamp over the reader, with spring and wing nuts.
  s += box({ x: 345, y: 221, w: 40, h: 8, d: 27, sw: 1 });
  s +=
    line([366, 220], [382, 112], "x-i", 5) +
    line([372, 214], [388, 117], "x-i", 1.2);
  s +=
    line([382, 112], [318, 61], "x-i", 4) +
    line([388, 117], [324, 67], "x-i", 1);
  for (const [x, y] of [
    [366, 220],
    [382, 112],
    [318, 61],
  ])
    s += circ(x, y, 5, "x-p x-i") + circ(x, y, 1.5, "x-k");
  s += poly(
    [
      [302, 57],
      [330, 65],
      [317, 92],
      [282, 82],
    ],
    "x-p x-i",
    ' stroke-width="1.2"',
  );
  s += poly(
    [
      [302, 57],
      [330, 65],
      [317, 92],
      [311, 87],
    ],
    "x-pat",
    ' style="fill:url(#d6)"',
  );
  // Terminal casing and stand. Screen content is React text so state stays readable.
  s += box({
    x: 485,
    y: 207,
    w: 49,
    h: 21,
    d: 27,
    top: null,
    side: "d8",
    sw: 1,
  });
  s += box({
    x: 449,
    y: 226,
    w: 127,
    h: 7,
    d: 34,
    top: "d2",
    side: "d8",
    sw: 1,
  });
  s += box({
    x: 410,
    y: 62,
    w: 223,
    h: 149,
    d: 47,
    top: "d2",
    side: "d10",
    sw: 1.5,
  });
  s += rect(421, 80, 163, 104, "x-k") + rect(427, 86, 151, 92, "x-p");
  s += plate(424, 67, 155, 9, "TICKETD / NATIVE AI ASSISTANT", { size: 5.4 });
  s += vents(641, 88, 12, 61, 4) + bolts(410, 62, 223, 149, 5);
  s += knob(605, 122, 12, {
    detents: 3,
    label: "ASK",
    cls: "fp-question-knob",
  });
  s += lamp(605, 166, 3.5, "fp-answer-lamp");
  s += plate(423, 190, 161, 12, "ANSWERS WITH SOURCES ATTACHED", { size: 5.6 });
  // Keyboard, inset key caps and a coiled cord.
  s += box({
    x: 409,
    y: 230,
    w: 235,
    h: 8,
    d: 30,
    top: "d2",
    side: "d8",
    sw: 1,
  });
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 16; col++) {
      const x = 425 + col * 13 - row * 3.5,
        y = 223 + row * 3.4;
      s += poly(
        [
          [x, y],
          [x + 9, y],
          [x + 12, y - 2.6],
          [x + 3, y - 2.6],
        ],
        "x-p x-i",
        ' stroke-width=".5"',
      );
    }
  s += pipe(
    [
      [634, 205],
      [674, 205],
      [674, 230],
      [651, 230],
    ],
    { w: 3.5 },
  );
  s += cat(698, 187, 1.9);
  // Output tray and a manual approval stamp. Draft never means added to the Plan.
  s += conveyor({ x: 790, y: 225, len: 202, d: 38, h: 10, legs: false });
  s += box({
    x: 803,
    y: 187,
    w: 158,
    h: 34,
    d: 32,
    top: "d4",
    side: "d8",
    sw: 1.1,
  });
  s += plate(815, 197, 133, 15, "REVIEW BEFORE ADDING", { size: 7 });
  s += box({
    x: 1011,
    y: 211,
    w: 63,
    h: 18,
    d: 32,
    top: "d2",
    side: "d8",
    sw: 1.3,
  });
  s += box({
    x: 1045,
    y: 133,
    w: 13,
    h: 78,
    d: 17,
    top: "d2",
    side: "d8",
    sw: 1.2,
  });
  s += plate(1016, 215, 52, 8, "ADD TO PLAN", { size: 4.6 });
  // Automation relay and bell. The open/closed bridge is supplied by React.
  s += pipe(
    [
      [663, 94],
      [716, 94],
      [716, 57],
      [993, 57],
      [993, 72],
    ],
    { w: 4 },
  );
  s += box({
    x: 954,
    y: 75,
    w: 144,
    h: 65,
    d: 30,
    top: "d2",
    side: "d8",
    sw: 1.3,
  });
  s += plate(964, 82, 122, 12, "REVIEW NOTIFICATION", { size: 6.6 });
  s += bolts(954, 75, 144, 65, 5) + lamp(1080, 114, 5, "fp-inbox-lamp");
  s +=
    circ(1018, 113, 10, "x-p x-i") +
    circ(1018, 113, 7, "x-pat", ' style="fill:url(#d4)"');
  s +=
    line([1018, 103], [1018, 109], "x-i", 1) +
    text(1018, 134, "TEST", 5.5, "x-t2", "middle");
  s += text(1080, 134, "INBOX", 5.5, "x-t2", "middle");
  s += line([46, 310], [1162, 310], "x-i", 0.7);
  let file = paper(0, 0, 41, 91);
  file += rect(4, -7, 31, 8, "x-p x-i", ' stroke-width=".8"');
  const draft = paper(0, 0, 108, 100);
  let stamp = box({
    x: 1005,
    y: 165,
    w: 65,
    h: 12,
    d: 23,
    top: "d2",
    side: "d8",
    sw: 1.2,
  });
  stamp +=
    line([1037, 165], [1037, 147], "x-i", 5) +
    box({ x: 1019, y: 138, w: 36, h: 9, d: 12, front: "x-k", sw: 1.1 });
  return { body: s, file, draft, stamp };
}

const path = fileURLToPath(
  new URL("../src/FactoryPlates.markup.json", import.meta.url),
);
await writeFile(
  path,
  await format(
    JSON.stringify({
      hero: hero(),
      archive: archive(),
      assistant: assistant(),
    }),
    {
      parser: "json",
    },
  ),
);
