import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const headerV1 = Buffer.from("ticketd-harness-recording-v1\n");
const headerV2 = Buffer.from("ticketd-harness-recording-v2\n");
const maxCaptureBytes = 64 * 1024 * 1024;
const maxFrameBytes = 8 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

class CaptureError extends Error {}

function readCapture(input) {
  const sizeError = "The input must be a recording file of at most 64 MiB.";
  // Avoid waiting on a pipe before we can check that the handle is a file.
  const fd = openSync(input, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxCaptureBytes) {
      throw new CaptureError(sizeError);
    }

    const chunks = [];
    let total = 0;
    while (total <= maxCaptureBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maxCaptureBytes + 1 - total),
      );
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (size === 0) return Buffer.concat(chunks, total);
      chunks.push(chunk.subarray(0, size));
      total += size;
    }
    throw new CaptureError(sizeError);
  } finally {
    closeSync(fd);
  }
}

function captureRoot(value) {
  if (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0")
  ) {
    const root = value.replace(/\/+$/, "");
    if (root) return root;
  }
  throw new CaptureError(
    "The recording capture root must be an absolute directory path.",
  );
}

function framesFrom(input) {
  if (!input.endsWith(".wire")) {
    throw new CaptureError("Use a finalized .wire recording.");
  }
  const raw = readCapture(input);
  let offset = headerV1.length;
  let roots = [];
  const format = raw.subarray(0, offset);
  if (format.equals(headerV2)) {
    const end = raw.indexOf(10, offset);
    try {
      if (end !== -1)
        roots = JSON.parse(decoder.decode(raw.subarray(offset, end)));
    } catch {
      throw new CaptureError("Invalid recording capture root metadata.");
    }
    if (!Array.isArray(roots) || roots.length !== 2) {
      throw new CaptureError("Invalid recording capture root metadata.");
    }
    roots = roots.map(captureRoot);
    offset = end + 1;
  } else if (!format.equals(headerV1)) {
    throw new CaptureError("Unknown recording format.");
  }

  const frames = [];
  const streams = {
    1: { direction: "client", chunks: [], size: 0, lines: 0 },
    2: { direction: "server", chunks: [], size: 0, lines: 0 },
  };
  while (offset < raw.length) {
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
  return { frames, roots };
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
        frames.push({ direction: stream.direction, frame });
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
const ambiguousSessionId = /^[\p{L}\p{M}\p{N}]+$/u;
// In "session id: VALUE", keep "id" as part of the label even if it is a
// Session ID elsewhere in the recording.
const sessionReferencePrefix =
  /(?<![\p{L}\p{M}\p{N}_-])(?:(?:[Ss]ession|[Tt]hread|[Cc]hat)(?:[ _-]?[Ii][Dd])?(?:[ \t]*[:=][ \t]*|[ \t]+(?![Ii][Dd][ \t]*[:=]))|--(?:session|thread|chat)(?:-id)?(?:=|[ \t]+))["'\x60]?/u;
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
const rpcCallFields = new Set([
  "jsonrpc",
  "id",
  "method",
  "params",
  "emittedAtMs",
]);
const rpcReplyFields = new Set(["jsonrpc", "id", "result", "error"]);
const claudeCommandFields = new Set(["cmd", "id", "protocol", "generation"]);
const claudeEventFields = new Set([
  "event",
  "id",
  "v",
  "protocol",
  "generation",
  "error",
]);
const envelopeLabels = new Set(["cmd", "event", "jsonrpc", "method"]);

function envelopeFields(frame, direction) {
  if (typeof frame.method === "string") return rpcCallFields;
  if (direction === "client" && typeof frame.cmd === "string") {
    return claudeCommandFields;
  }
  if (direction === "server" && typeof frame.event === "string") {
    return claudeEventFields;
  }
  return Object.hasOwn(frame, "id") &&
    (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))
    ? rpcReplyFields
    : null;
}

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

function visit(value, scope, parent, scalar, key, wireFields = null) {
  if (Array.isArray(value)) {
    return value.map((entry) => visit(entry, scope, parent, scalar, key));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([field, entry]) => [
      key(field, entry, wireFields),
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

function scrub(frames, captureDirectories) {
  const aliases = new Map();
  const accountAliases = new Map();
  const ambiguousSessionAliases = new Set();
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
    if (scope === "session" && ambiguousSessionId.test(value)) {
      ambiguousSessionAliases.add(value);
    }
    return replacement;
  };

  // Keep filenames, relative paths and tool arguments when masking a capture root.
  for (const directory of captureDirectories) {
    remember(directory, () => "/fixture");
  }
  // Collect aliases first so a reference before its structured definition, or
  // in a command, message, or path, can use the same replacement.
  for (const { frame } of frames) {
    visit(
      frame,
      null,
      "",
      (value, scope) =>
        scope && scope !== "label" ? replaceScoped(value, scope) : value,
      (key) => key,
    );
  }
  const textAliases = [];
  const sessionReferences = [];
  for (const value of [...aliases.keys()].sort(
    (left, right) => right.length - left.length,
  )) {
    const literal = value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    // An ordinary word can also be a Session ID. Use a label or flag to
    // identify its references. Known account values still need redaction.
    if (ambiguousSessionAliases.has(value) && !accountAliases.has(value)) {
      sessionReferences.push(literal);
    } else {
      textAliases.push(literal);
    }
  }
  const alternatives = [
    ...(textAliases.length
      ? [
          String.raw`(?<alias>(?<![\p{L}\p{N}_-])(?:${textAliases.join("|")})(?![\p{L}\p{N}_-]))`,
        ]
      : []),
    "(?<windowsHome>" + windowsHome.source + ")",
    "(?<unixHome>" + unixHome.source + ")",
    "(?<email>" + email.source + ")",
    "(?<uuid>" + uuid.source + ")",
    ...(sessionReferences.length
      ? [
          String.raw`(?<sessionReference>(?=[\p{L}\p{M}\p{N}])(?<=${sessionReferencePrefix.source})(?:${sessionReferences.join("|")})(?![\p{L}\p{M}\p{N}_-]))`,
        ]
      : []),
  ];
  const privateText = new RegExp(alternatives.join("|"), "gu");
  const replaceText = (value) =>
    value.replace(privateText, (matched, ...captures) => {
      const groups = captures.at(-1);
      if (groups.alias || groups.sessionReference) return aliases.get(matched);
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

  const checkDiscriminator = (value) => {
    if (typeof value === "string" && replaceText(value) !== value) {
      throw new CaptureError(
        "Cannot safely scrub an alias in a protocol label.",
      );
    }
  };

  // ACP dispatches on the nested sessionUpdate tag. Check its protocol
  // position so the same spelling can still be scrubbed inside dictionaries.
  for (const { direction, frame } of frames) {
    if (direction !== "server" || frame.method !== "session/update") continue;
    const { params } = frame;
    const update = params?.update;
    if (typeof update?.sessionUpdate !== "string") continue;
    if (
      [...Object.keys(params), ...Object.keys(update)].some((field) =>
        accountAliases.has(field),
      )
    ) {
      throw new CaptureError(
        "Cannot safely scrub an account alias in a protocol field name.",
      );
    }
    checkDiscriminator(update.sessionUpdate);
  }

  const originalIds = new Map();
  return frames.map(({ direction, frame }) => {
    const wireFields = envelopeFields(frame, direction);
    const scrubbed = visit(
      frame,
      null,
      "",
      (value, scope) =>
        scope && scope !== "label"
          ? replaceScoped(value, scope)
          : typeof value === "string"
            ? replaceText(value)
            : value,
      (key, value, wireFields) => {
        // Wire fields have fixed names. A dictionary can use the same spelling
        // as a key, so this exception applies only to the frame envelope.
        if (wireFields?.has(key)) {
          if (envelopeLabels.has(key)) checkDiscriminator(value);
          return key;
        }
        const alias = accountAliases.get(key);
        if (alias !== undefined) {
          if (wireFields) {
            throw new CaptureError(
              "Cannot safely scrub an account alias in a protocol field name.",
            );
          }
          return alias;
        }
        return /^[A-Za-z_$][\w$]*$/.test(key) ? key : replaceText(key);
      },
      wireFields,
    );
    if (wireFields?.has("id") && typeof frame.id === "string") {
      const previous = originalIds.get(scrubbed.id);
      if (previous !== undefined && previous !== frame.id) {
        throw new CaptureError("Scrubbing would produce duplicate RPC IDs.");
      }
      originalIds.set(scrubbed.id, frame.id);
    }
    return { [direction]: scrubbed };
  });
}

function argumentsForScrubbing() {
  const usage =
    "Usage: node scripts/scrub-harness-recording.mjs [--capture-root DIR] RAW.wire FIXTURE.jsonl";
  let args;
  try {
    args = parseArgs({
      options: { "capture-root": { type: "string", multiple: true } },
      allowPositionals: true,
    });
  } catch {
    throw new CaptureError(usage);
  }
  if (args.positionals.length !== 2) throw new CaptureError(usage);
  return args;
}

try {
  const {
    positionals: [input, output],
    values,
  } = argumentsForScrubbing();
  const { frames, roots } = framesFrom(input);
  // Legacy recordings made in place use the path supplied to the scrubber.
  // The header and explicit origins survive a move of the wire file.
  const captureDirectories = [
    dirname(resolve(input)),
    dirname(realpathSync(input)),
  ].filter((directory) => dirname(directory) !== directory);
  const scrubbed = scrub(frames, [
    ...captureDirectories,
    ...roots,
    ...(values["capture-root"] ?? []).map(captureRoot),
  ]);
  const fixture = scrubbed
    .map((frame) => JSON.stringify(frame) + "\n")
    .join("");
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
