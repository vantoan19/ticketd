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

function failure(message: string, name = "TypeError") {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at render (tauri://localhost/assets/index.js:10:5)\n    at commit (tauri://localhost/assets/index.js:20:7)`;
  return error;
}

function rejection(reason: unknown) {
  window.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), { reason }),
  );
}

test("a window error is sent with its name, message, frames, route and a count of one", () => {
  install("chats");
  window.dispatchEvent(
    new ErrorEvent("error", { error: failure("x is undefined") }),
  );
  expect(sent).toEqual([
    {
      name: "TypeError",
      message: "x is undefined",
      frames: [
        "at render (tauri://localhost/assets/index.js:10:5)",
        "at commit (tauri://localhost/assets/index.js:20:7)",
      ],
      route: "chats",
      count: 1,
    },
  ]);
});

test("an unhandled rejection is reported, including a reason that is not an Error", () => {
  install();
  rejection(failure("lost", "RangeError"));
  rejection("plain text");
  expect(sent.map(({ name, message }) => [name, message])).toEqual([
    ["RangeError", "lost"],
    ["NonError", "plain text"],
  ]);
});

test("the React root's uncaught-error callback reports through the same path", () => {
  const reporter = install();
  reporter.report(failure("render failed"));
  expect(sent).toHaveLength(1);
  expect(sent[0]?.message).toBe("render failed");
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
  for (let i = 0; i < 25; i += 1) reporter.report(failure(`distinct ${i}`));
  expect(sent).toHaveLength(10);

  clock += 61_000;
  reporter.report(failure("distinct 24"));
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

test("long messages and deep stacks are bounded", () => {
  const reporter = install();
  const error = failure("m".repeat(5000));
  error.stack = `TypeError: x\n${Array.from({ length: 50 }, (_, i) => `    at f${i} (file.js:1:1)`).join("\n")}`;
  reporter.report(error);
  expect(sent[0]?.message.length).toBeLessThanOrEqual(500);
  expect(sent[0]?.frames).toHaveLength(10);
});
