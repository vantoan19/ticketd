import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL("./scrub-harness-recording.mjs", import.meta.url),
);

function capture(t) {
  const directory = mkdtempSync(join(tmpdir(), "ticketd-synthetic-capture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, "synthetic.wire");
  const output = join(directory, "fixture.jsonl");
  return {
    directory,
    output,
    scrub(chunks) {
      const contents = [Buffer.from("ticketd-harness-recording-v1\n")];
      for (const [direction, bytes] of chunks) {
        const header = Buffer.alloc(5);
        header[0] = direction;
        header.writeUInt32LE(bytes.length, 1);
        contents.push(header, bytes);
      }
      writeFileSync(input, Buffer.concat(contents));
      return spawnSync(process.execPath, [cli, input, output], {
        encoding: "utf8",
      });
    },
  };
}

function line(frame) {
  return Buffer.from(JSON.stringify(frame) + "\n");
}

test("scrubs structured and embedded identities while keeping protocol and tool evidence", (t) => {
  const { directory, output, scrub } = capture(t);
  const session = "synthetic-private-session";
  const otherSession = "00001111-2222-4333-8444-555566667777";
  const email = "synthetic-private@example.test";
  const account = "Synthetic Member Name";
  const key = "synthetic-private-api-key";
  const work = join(directory, "work");
  const write = "example output\n".repeat(1800);
  const client = line({
    id: 42,
    method: "thread/resume",
    params: { threadId: session, cwd: work },
  });
  const server = line({
    id: 42,
    result: {
      thread: { id: session, sessionId: session },
      account: { type: "chatgpt", displayName: account, email, apiKey: key },
      item: {
        id: "item-1",
        type: "fileChange",
        path: work + "/example.txt",
        content: write,
      },
    },
  });
  const stream = line({
    event: "tool_output",
    id: "item-1",
    session_id: otherSession,
    command: "cat /Users/synthetic-mac/private/example.txt",
    unixPath: "/home/Synthetic Linux/files/example.txt",
    text: `Report for ${account} <${email}> with ${key} in ${session} and ${otherSession}`,
    path: "C:\\Users\\Synthetic Windows\\files\\example.txt",
  });
  const result = scrub([
    [1, client.subarray(0, 5)],
    [1, client.subarray(5)],
    [2, server],
    [2, stream],
    [1, line({ cmd: "open", id: "c2", resume_session_id: otherSession })],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const fixture = readFileSync(output, "utf8");
  for (const privateText of [
    session,
    otherSession,
    email,
    account,
    key,
    directory,
    "synthetic-mac",
    "Synthetic Windows",
    "Synthetic Linux",
    " Linux/",
  ]) {
    assert.ok(
      !fixture.includes(privateText),
      "private value escaped scrubbing",
    );
  }
  const [first, second, third, fourth] = fixture
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  const resumed = first.client.params.threadId;
  assert.equal(first.client.id, 42);
  assert.equal(second.server.id, 42);
  assert.equal(second.server.result.thread.id, resumed);
  assert.equal(second.server.result.thread.sessionId, resumed);
  assert.ok(third.server.text.includes(resumed));
  assert.equal(third.server.session_id, fourth.client.resume_session_id);
  assert.ok(third.server.text.includes(third.server.session_id));
  assert.notEqual(third.server.session_id, resumed);
  assert.equal(fourth.client.id, "c2");
  assert.deepEqual(second.server.result.item, {
    id: "item-1",
    type: "fileChange",
    path: first.client.params.cwd + "/example.txt",
    content: write,
  });
  assert.equal(third.server.id, "item-1");
  assert.match(third.server.unixPath, /\/files\/example\.txt$/);
  assert.match(third.server.command, /^cat .*\/private\/example\.txt$/);
  assert.match(third.server.path, /\\files\\example\.txt$/);
});

test("rejects malformed data before creating a fixture or printing private bytes", (t) => {
  const { directory, output, scrub } = capture(t);
  const sensitive = "synthetic-private-parse-error";
  const result = scrub([
    [1, line({ cmd: "hello", id: "c1" })],
    [2, Buffer.from(sensitive + "\n")],
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid server JSON frame at line 1/);
  assert.ok(!result.stderr.includes(sensitive));
  assert.ok(!result.stderr.includes(directory));
  assert.equal(existsSync(output), false);
});

test("keeps protocol labels and known login metadata when an alias shares their spelling", (t) => {
  const { output, scrub } = capture(t);
  const account = {
    api_provider: "firstParty",
    api_key_source: "none",
    subscription_type: "max",
    email: "profile@example.invalid",
  };
  const result = scrub([
    [1, line({ id: 1, method: "thread/resume", params: { threadId: "id" } })],
    [2, line({ id: 1, event: "options", account, command: "cd /root," })],
    [2, line({ path: "/users/SyntheticLower/example.txt" })],
    [2, line({ path: "C:\\USERS\\Synthetic Upper\\example.txt" })],
  ]);
  assert.equal(result.status, 0, result.stderr);
  const fixture = readFileSync(output, "utf8");
  for (const secret of [
    account.email,
    "/root,",
    "SyntheticLower",
    "Synthetic Upper",
  ]) {
    assert.ok(!fixture.includes(secret), "private value escaped scrubbing");
  }
  const [request, reply] = fixture.trimEnd().split("\n").map(JSON.parse);
  assert.equal(request.client.id, 1);
  assert.equal(request.client.method, "thread/resume");
  assert.notEqual(request.client.params.threadId, "id");
  assert.equal(reply.server.id, 1);
  assert.equal(reply.server.event, "options");
  assert.equal(reply.server.account.api_provider, "firstParty");
  assert.equal(reply.server.account.api_key_source, "none");
  assert.equal(reply.server.account.subscription_type, "max");
});

test("rejects frames with integers the scrubber cannot preserve", (t) => {
  const { output, scrub } = capture(t);
  const result = scrub([
    [1, Buffer.from('{"id":9007199254740993,"method":"thread/resume"}\n')],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid client JSON frame at line 1/);
  assert.equal(existsSync(output), false);
});
