import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const header = Buffer.from("ticketd-harness-recording-v1\n");
const maxCaptureBytes = 64 * 1024 * 1024;
const maxFrameBytes = 8 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

class CaptureError extends Error {}

function framesFrom(input) {
  if (!input.endsWith(".wire")) {
    throw new CaptureError("Use a finalized .wire recording.");
  }
  const stat = statSync(input);
  if (!stat.isFile() || stat.size > maxCaptureBytes) {
    throw new CaptureError(
      "The input must be a recording file of at most 64 MiB.",
    );
  }
  const raw = readFileSync(input);
  if (!raw.subarray(0, header.length).equals(header)) {
    throw new CaptureError("Unknown recording format.");
  }

  const frames = [];
  const streams = {
    1: { direction: "client", chunks: [], size: 0, lines: 0 },
    2: { direction: "server", chunks: [], size: 0, lines: 0 },
  };
  for (let offset = header.length; offset < raw.length;) {
    const stream = streams[raw[offset]];
    if (!stream || offset + 5 > raw.length) {
      throw new CaptureError("Invalid recording chunk header.");
    }
    const size = raw.readUInt32LE(offset + 1);
    offset += 5;
    if (size === 0 || offset + size > raw.length) {
      throw new CaptureError("Invalid recording chunk size.");
    }
    readChunk(raw.subarray(offset, offset + size), stream, frames);
    offset += size;
  }
  if (Object.values(streams).some((stream) => stream.size > 0)) {
    throw new CaptureError("The recording ends with an incomplete frame.");
  }
  if (frames.length === 0) {
    throw new CaptureError("The recording contains no frames.");
  }
  return frames;
}

function readChunk(bytes, stream, frames) {
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(10, offset);
    const part = bytes.subarray(offset, end === -1 ? bytes.length : end);
    stream.size += part.length;
    stream.chunks.push(part);
    if (stream.size > maxFrameBytes) {
      throw new CaptureError("A protocol frame exceeds 8 MiB.");
    }
    if (end === -1) return;

    stream.lines += 1;
    try {
      const text = decoder.decode(Buffer.concat(stream.chunks, stream.size));
      if (text.trim() !== "") {
        const frame = JSON.parse(text, (_key, value) => {
          if (
            typeof value === "number" &&
            (!Number.isFinite(value) ||
              (Number.isInteger(value) && !Number.isSafeInteger(value)))
          ) {
            throw new Error();
          }
          return value;
        });
        if (
          frame === null ||
          Array.isArray(frame) ||
          typeof frame !== "object"
        ) {
          throw new Error();
        }
        frames.push({ [stream.direction]: frame });
      }
    } catch {
      throw new CaptureError(
        "Invalid " +
          stream.direction +
          " JSON frame at line " +
          stream.lines +
          ".",
      );
    }
    stream.size = 0;
    stream.chunks = [];
    offset = end + 1;
  }
}

const sessionFields =
  /^(?:(?:parent|resume|forkedfrom|source|native)?(?:session|thread)(?:id|ids|uuid)|chatid)$/;
const accountFields =
  /^(?:accounts?|account(?:id|name|info|number)|organizations?|organization(?:id|name|uuid)|org(?:id|name|uuid)|email(?:address)?|user(?:id|name)|(?:access|refresh|auth|oauth|api)token|apikey|authorization|password|secret|credentials)$/;
const unixHome =
  /(?:^|(?<=["']))\/(?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee])\/[^/\r\n"'<>|]+(?=\/|["']|$)|\/(?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee])\/(?:\\ |[^\s\/\\"'<>,:;|&()[\]{}])+|\/root(?![\p{L}\p{N}_-])/g;
const windowsHome =
  /[A-Za-z]:[\\/][Uu][Ss][Ee][Rr][Ss][\\/][^\\/\r\n"'<>|:]+?(?=[\\/]|["'<>]|$)/gi;
const email = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}.-]+\.[\p{L}\p{N}]+/gu;
const uuid = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\b/gi;

// Account identities are private. These recognized labels express protocol
// choices and keep the meaning of login reports after scrubbing.
const accountLabels = new Map([
  ["type", /^(?:chatgpt|apiKey)$/],
  [
    "apiprovider",
    /^(?:firstParty|bedrock|vertex|foundry|anthropicAws|anthropicGoogleCloud|mantle|gateway)$/,
  ],
  [
    "apikeysource",
    /^(?:none|user|project|org|oauth|apiKeyHelper|ANTHROPIC_API_KEY|temporary)$/,
  ],
  [
    "tokensource",
    /^(?:none|claude\.ai|oauth|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/,
  ],
  ["subscriptiontype", /^(?:free|pro|max|team|enterprise|ultra)$/i],
]);
const protocolLabels = new Set([
  "cmd",
  "event",
  "jsonrpc",
  "kind",
  "method",
  "name",
  "type",
]);

function scopeFor(scope, key, parent, value) {
  const field = key.toLowerCase().replace(/[_-]/g, "");
  if (
    sessionFields.test(field) ||
    (field === "id" && /^(?:thread|session)$/.test(parent))
  ) {
    return "session";
  }
  if (
    scope === "account" &&
    typeof value === "string" &&
    accountLabels.get(field)?.test(value)
  ) {
    return "label";
  }
  if (accountFields.test(field) || scope === "account") {
    return "account";
  }
  if (
    protocolLabels.has(field) &&
    typeof value === "string" &&
    /^[\w/.-]+$/.test(value)
  ) {
    return "label";
  }
  return null;
}

function visit(value, scope, parent, scalar, key) {
  if (Array.isArray(value)) {
    return value.map((entry) => visit(entry, scope, parent, scalar, key));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([field, entry]) => [
      key(field),
      visit(
        entry,
        scopeFor(scope, field, parent, entry),
        field.toLowerCase(),
        scalar,
        key,
      ),
    ]);
    const result = Object.fromEntries(entries);
    if (Object.keys(result).length !== entries.length) {
      throw new CaptureError("Scrubbing would produce duplicate object keys.");
    }
    return result;
  }
  return scalar(value, scope);
}

function scrub(frames, input) {
  const aliases = new Map();
  const accountAliases = new Map();
  let accountCount = 0;
  let sessionCount = 0;
  let homeCount = 0;
  let emailCount = 0;
  let uuidCount = 0;
  const remember = (value, placeholder) => {
    if (!aliases.has(value)) aliases.set(value, placeholder());
    return aliases.get(value);
  };
  const replaceUuid = (value) =>
    remember(
      value.toLowerCase(),
      () =>
        "00000000-0000-4000-8000-" +
        (++uuidCount).toString(16).padStart(12, "0"),
    );
  const replaceScoped = (value, scope) => {
    if (value === null || value === "") return value;
    if (typeof value !== "string") return null;
    const replacement =
      value.match(uuid)?.[0] === value
        ? replaceUuid(value)
        : remember(value, () =>
            scope === "session"
              ? "fixture-session-" + ++sessionCount
              : "fixture-account-" + ++accountCount,
          );
    if (scope === "account") accountAliases.set(value, replacement);
    return replacement;
  };

  // Match both the launch spelling and its physical path (for example /var and
  // /private/var on macOS). Keep filenames, relative paths and tool arguments.
  for (const directory of [
    dirname(resolve(input)),
    dirname(realpathSync(input)),
  ]) {
    if (dirname(directory) !== directory) remember(directory, () => "/fixture");
  }
  // Collect aliases first so a reference before its structured definition, or
  // in a command, message, or path, can use the same replacement.
  for (const frame of frames) {
    visit(
      frame,
      null,
      "",
      (value, scope) =>
        scope && scope !== "label" ? replaceScoped(value, scope) : value,
      (key) => key,
    );
  }
  const aliasPattern = [...aliases.keys()]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("|");
  const alternatives = [
    ...(aliasPattern
      ? [
          String.raw`(?<alias>(?<![\p{L}\p{N}_-])(?:${aliasPattern})(?![\p{L}\p{N}_-]))`,
        ]
      : []),
    "(?<windowsHome>" + windowsHome.source + ")",
    "(?<unixHome>" + unixHome.source + ")",
    "(?<email>" + email.source + ")",
    "(?<uuid>" + uuid.source + ")",
  ];
  const privateText = new RegExp(alternatives.join("|"), "gu");
  const replaceText = (value) =>
    value.replace(privateText, (matched, ...captures) => {
      const groups = captures.at(-1);
      if (groups.alias) return aliases.get(matched);
      if (groups.windowsHome) {
        return remember(
          matched,
          () => matched.slice(0, 2) + "\\fixture\\home-" + ++homeCount,
        );
      }
      if (groups.unixHome)
        return remember(matched, () => "/fixture/home-" + ++homeCount);
      if (groups.email)
        return remember(matched, () => "fixture-email-" + ++emailCount);
      return replaceUuid(matched);
    });
  return frames.map((frame) =>
    visit(
      frame,
      null,
      "",
      (value, scope) =>
        scope === "label"
          ? (accountAliases.get(value) ?? value)
          : scope
            ? replaceScoped(value, scope)
            : typeof value === "string"
              ? replaceText(value)
              : value,
      // Dictionary keys can repeat an account alias or contain paths, email
      // addresses and punctuated identifiers. Keep ordinary protocol keys.
      (key) =>
        accountAliases.get(key) ??
        (/^[A-Za-z_$][\w$]*$/.test(key) ? key : replaceText(key)),
    ),
  );
}

try {
  const [, , input, output, extra] = process.argv;
  if (!input || !output || extra !== undefined) {
    throw new CaptureError(
      "Usage: node scripts/scrub-harness-recording.mjs RAW.wire FIXTURE.jsonl",
    );
  }
  const frames = scrub(framesFrom(input), input);
  const fixture = frames.map((frame) => JSON.stringify(frame) + "\n").join("");
  writeFileSync(output, fixture, { flag: "wx", mode: 0o600 });
} catch (error) {
  // Parser and filesystem errors can quote capture bytes or private filenames.
  // Only messages authored in this script are safe to print.
  process.stderr.write(
    (error instanceof CaptureError
      ? error.message
      : "Could not scrub the recording. Check that the input is readable and the output is a new file.") +
      "\n",
  );
  process.exitCode = 1;
}
