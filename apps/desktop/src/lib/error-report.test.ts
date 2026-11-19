// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";
import { installErrorReporter, type ErrorReport } from "./error-report";

let uninstall: (() => void) | undefined;
let sent: ErrorReport[];
let clock: number;

beforeEach(() => {
  sent = [];
  clock = 1_000_000;
});
afterEach(() => uninstall?.());

function install(route = "tickets") {
  const reporter = installErrorReporter({
    send: (report) => void sent.push(report),
    route: () => route,
    now: () => clock,
  });
  uninstall = reporter.uninstall;
  return reporter;
}

/** `site` is the file the error was thrown from; the same site is the same failure. */
function failure(message: string, name = "TypeError", site = "index.js") {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at render (tauri://localhost/assets/${site}:10:5)\n    at commit (tauri://localhost/assets/${site}:20:7)`;
  return error;
}

function rejection(reason: unknown) {
  window.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), { reason }),
  );
}

test("a window error is sent with its name, frames, route and a count of one, and never its message", () => {
  install("chats");
  window.dispatchEvent(
    new ErrorEvent("error", { error: failure("x is undefined") }),
  );
  expect(sent).toEqual([
    {
      name: "TypeError",
      frames: ["index.js:10:5", "index.js:20:7"],
      route: "chats",
      count: 1,
    },
  ]);
  expect(JSON.stringify(sent)).not.toContain("x is undefined");
});

test("frames lose their URLs, query strings and function names, whichever engine wrote them", () => {
  const reporter = install();
  const error = failure("boom");
  error.stack = [
    "TypeError: boom at secret.js:1:1",
    "    at render (https://app.test/assets/index-AB12.js?token=abc&next=/a/b:3:4)",
    "    at async Promise.all (index 0)",
    "    at tauri://localhost/assets/chunk.js:5:6",
    "render@tauri://localhost/assets/safari.js:7:8",
    "@tauri://localhost/assets/anonymous.js:9:10",
    "[native code]",
  ].join("\n");
  reporter.report(error);
  expect(sent[0]?.frames).toEqual([
    "index-AB12.js:3:4",
    "chunk.js:5:6",
    "safari.js:7:8",
    "anonymous.js:9:10",
  ]);
});

test("an unhandled rejection is reported, including a reason that is not an Error", () => {
  install();
  rejection(failure("lost", "RangeError"));
  rejection("plain text");
  expect(sent.map(({ name }) => name)).toEqual(["RangeError", "NonError"]);
  expect(JSON.stringify(sent)).not.toContain("plain text");
});

test("the React root's uncaught-error callback reports through the same path", () => {
  const reporter = install();
  reporter.report(failure("render failed"));
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain("render failed");
});

test("a repeat of the same error is dropped, then counted when it is next sent", () => {
  const reporter = install();
  reporter.report(failure("boom"));
  reporter.report(failure("boom"));
  reporter.report(failure("boom"));
  expect(sent.map((report) => report.count)).toEqual([1]);

  clock += 61_000;
  reporter.report(failure("boom"));
  expect(sent.map((report) => report.count)).toEqual([1, 3]);
});

test("at most ten reports are sent a minute, whatever they are", () => {
  const reporter = install();
  for (let i = 0; i < 25; i += 1)
    reporter.report(failure("boom", "TypeError", `site${i}.js`));
  expect(sent).toHaveLength(10);

  clock += 61_000;
  reporter.report(failure("boom", "TypeError", "site24.js"));
  expect(sent).toHaveLength(11);
  // It was dropped once by the limit, so the count says so.
  expect(sent[10]?.count).toBe(2);
});

test("a sender that throws or rejects never raises another error", async () => {
  const throwing = installErrorReporter({
    send: () => {
      throw new Error("bridge down");
    },
    route: () => "tickets",
    now: () => clock,
  });
  expect(() => throwing.report(failure("one"))).not.toThrow();
  throwing.uninstall();

  const rejecting = installErrorReporter({
    send: () => Promise.reject(new Error("bridge down")),
    route: () => "tickets",
    now: () => clock,
  });
  uninstall = rejecting.uninstall;
  // An unhandled rejection here would fail the run.
  rejecting.report(failure("two"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("deep stacks are bounded", () => {
  const reporter = install();
  const error = failure("m".repeat(5000));
  error.stack = `TypeError: x\n${Array.from({ length: 50 }, (_, i) => `    at f${i} (file${i}.js:1:1)`).join("\n")}`;
  reporter.report(error);
  expect(sent[0]?.frames).toHaveLength(10);
});
