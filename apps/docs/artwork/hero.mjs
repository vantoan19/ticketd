// One connected workshop. The product screen and controls are live HTML;
// these plates supply the same oblique, stippled machinery as the other scenes.
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
  sphere,
  lamp,
  poly,
} from "./draw.mjs";

export function hero() {
  let body = "";
  // Both sides have separate supply and return lines, with visible unions.
  const routes = [
    [
      [238, 260],
      [284, 260],
      [284, 214],
      [338, 214],
    ],
    [
      [338, 352],
      [284, 352],
      [284, 397],
      [235, 397],
    ],
    [
      [1097, 214],
      [1160, 214],
      [1160, 163],
      [1247, 163],
    ],
    [
      [1247, 330],
      [1181, 330],
      [1181, 369],
      [1097, 369],
    ],
  ];
  for (const points of routes) body += pipe(points, { w: 9 });
  // A shared bed, levelling feet and foundation make this one installation.
  body += shadow(42, 454, 1324, 47, 17);
  for (const x of [66, 357, 1014, 1318]) {
    body += box({ x, y: 449, w: 33, h: 16, d: 25, side: "d10", sw: 1.2 });
    body += rect(x - 5, 465, 46, 5, "x-p x-i");
  }
  body += box({ x: 38, y: 437, w: 1331, h: 13, d: 38, top: "d2", side: "d10" });
  for (let x = 49; x < 1360; x += 27) body += circ(x, 444, 1.4, "x-k");
  body += line([21, 480], [1412, 480], "x-i", 0.6);

  // Main factory: a broad screen set into a cast, vented housing.
  body += box({
    x: 338,
    y: 87,
    w: 760,
    h: 345,
    d: 47,
    top: "d2",
    side: "d10",
    sw: 1.8,
  });
  body += box({
    x: 390,
    y: 61,
    w: 645,
    h: 25,
    d: 28,
    top: "d1",
    side: "d8",
    sw: 1.3,
  });
  body += plate(
    406,
    66,
    610,
    15,
    "TICKETD WORKS / SHARED CONTEXT, ORGANIZED WORK",
    { size: 10 },
  );
  body += rect(353, 101, 730, 301, "x-k");
  body += rect(360, 108, 716, 287, "x-p x-i", ' stroke-width="1"');
  body += bolts(338, 87, 760, 345, 8);
  body += vents(379, 414, 156, 7, 29);
  body += plate(562, 409, 283, 17, "TICKETS · CONTEXT · ACTIVITY", {
    size: 8,
  });
  body += lamp(876, 418, 4, "hf-factory-lamp");
  body += text(891, 422, "LOCAL FIRST", 8, "x-t2");
  body += knob(1046, 417, 8, { detents: 3 });
  for (let y = 117; y < 399; y += 12) {
    body += line([1105, y], [1117, y - 7], "x-i", 2);
  }
  // Input roller and output inspection slot on the left side of the housing.
  body += box({
    x: 319,
    y: 195,
    w: 19,
    h: 38,
    d: 12,
    top: "d2",
    side: "d8",
    sw: 1.1,
  });
  body += rect(324, 202, 6, 24, "x-k");
  body += box({
    x: 319,
    y: 336,
    w: 19,
    h: 33,
    d: 12,
    top: "d2",
    side: "d8",
    sw: 1.1,
  });
  for (const y of [201, 354]) body += circ(1098, y, 8, "x-p x-i");

  // Agent engine: wound core, orbital band, service pedestal, report reader.
  body += box({
    x: 1241,
    y: 257,
    w: 130,
    h: 173,
    d: 35,
    top: "d2",
    side: "d10",
    sw: 1.5,
  });
  body += plate(1252, 270, 109, 17, "AGENT ENGINE", { size: 8 });
  body += bolts(1241, 257, 130, 173, 6);
  body += box({
    x: 1225,
    y: 244,
    w: 161,
    h: 14,
    d: 42,
    top: "d2",
    side: "d10",
    sw: 1.3,
  });
  body += line([1279, 244], [1279, 218], "x-i", 6);
  body += line([1339, 244], [1339, 219], "x-i", 6);
  body += sphere(1308, 176, 65, { grid: 4 });
  body +=
    '<ellipse class="x-i x-n" cx="1308" cy="177" rx="91" ry="20" transform="rotate(-16 1308 177)" stroke-width="1.1"/>';
  body += circ(1395, 152, 3, "x-a");
  body += rect(1266, 305, 85, 72, "x-p x-i");
  body += circ(1308, 340, 40, "x-p x-i", ' stroke-width="2"');
  body += circ(1308, 340, 34, "x-p x-i", ' stroke-width="1"');
  body += plate(1253, 393, 108, 23, "UPDATES / EVIDENCE", { size: 6.8 });
  body += vents(1255, 422, 94, 4, 19);
  body += box({
    x: 1212,
    y: 306,
    w: 29,
    h: 44,
    d: 20,
    top: "d2",
    side: "d8",
    sw: 1,
  });
  body += rect(1217, 313, 13, 27, "x-k");
  body += plate(1264, 83, 90, 16, "AI / CONNECTED", { size: 7.5 });
  body += line([1308, 100], [1308, 111], "x-i", 1);

  // The foreman's desk is a foreground plate so the cat sits behind it.
  let desk = box({
    x: 53,
    y: 303,
    w: 181,
    h: 126,
    d: 32,
    top: "d2",
    side: "d10",
    sw: 1.5,
  });
  desk += box({
    x: 43,
    y: 292,
    w: 204,
    h: 13,
    d: 42,
    top: "d1",
    side: "d10",
    sw: 1.3,
  });
  desk += plate(65, 319, 158, 20, "YOU ARE IN CHARGE", { size: 8 });
  desk += bolts(53, 303, 181, 126, 6);
  desk += gauge(97, 369, 23, 0.38, { label: "IDEAS" });
  desk += knob(183, 371, 19, { detents: 5 });
  desk += plate(74, 403, 137, 14, "CONTEXT / REVIEW", { size: 6.8 });
  desk += conveyor({ x: 204, y: 261, len: 67, d: 24, h: 12, legs: false });
  desk += box({
    x: 212,
    y: 274,
    w: 31,
    h: 20,
    d: 19,
    top: "d2",
    side: "d8",
    sw: 1,
  });
  desk += rect(218, 279, 15, 5, "x-k");
  // Cup, clipboard and a well-used lever.
  desk += rect(62, 269, 15, 21, "x-p x-i");
  desk += '<path class="x-i x-n" d="M77 274h5v10h-5" stroke-width="1.2"/>';
  desk += text(69.5, 283, "#1", 6, "x-t", "middle");
  desk += poly(
    [
      [93, 283],
      [137, 283],
      [146, 278],
      [102, 278],
    ],
    "x-p x-i",
    ' stroke-width="1"',
  );
  desk += line([175, 291], [188, 267], "x-i", 3) + circ(188, 266, 6, "x-a x-i");
  desk += lamp(222, 312, 5, "hf-review-lamp");
  // Cable under the cat's desk: a small decorative detail.
  desk +=
    '<path class="x-i x-n" d="M59 390C17 392 18 435 53 430C81 426 12 463 15 415" stroke-width="2"/>';
  desk += rect(11, 406, 8, 11, "x-k");

  let wheel = "";
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    wheel += line(
      [1308 + Math.cos(angle) * 11, 340 + Math.sin(angle) * 11],
      [1308 + Math.cos(angle) * 30, 340 + Math.sin(angle) * 30],
      "x-i",
      3,
    );
  }
  wheel += circ(1308, 340, 11, "x-p x-i") + circ(1308, 340, 4, "x-k");
  return { body, desk, cat: cat(88, 183, 4.5), wheel };
}
