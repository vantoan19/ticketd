import { invoke } from "@/lib/api/bridge-failure";

/**
 * What the native log learns about an uncaught error. The name is the error's
 * own; each frame is only `file:line:column` (no URL, query string or function
 * name); the route is the view the person was on. The message is never sent:
 * it can quote a Ticket, a Document or a Harness. `count` is how many times
 * this error happened since it was last sent.
 */
export interface ErrorReport {
  name: string;
  frames: string[];
  route: string;
  count: number;
}

interface Options {
  send?: (report: ErrorReport) => void | Promise<unknown>;
  /** The view the person is on, read when an error is reported. */
  route?: () => string;
  now?: () => number;
}

export interface ErrorReporter {
  /** For the React root's `onUncaughtError`, which window events do not see. */
  report: (error: unknown) => void;
  uninstall: () => void;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_KINDS = 100;
const MAX_FRAMES = 10;
const MAX_LINE = 500;

/**
 * One stack line, as Chrome writes it (`at fn (url:1:2)`) or Safari and Firefox
 * do (`fn@url:1:2`). It captures the file's base name and the position, which
 * is all a report keeps. A line that is not a frame (the error's header, with
 * its message) does not match.
 */
const FRAME =
  /^(?:at\s+(?:.*?\()?|[^\s@]*@)?(?:[^\s()?#]*[/\\])?([\w.$-]+?)(?:[?#][^\s()]*)?:(\d+):(\d+)\)?$/;

/** A report's identity: the same failure at the same place is a repeat. */
function identity(report: Omit<ErrorReport, "count">) {
  return `${report.name}\n${report.frames[0] ?? ""}`;
}

function describe(error: unknown, route: string): Omit<ErrorReport, "count"> {
  const isError = error instanceof Error;
  const name = isError && error.name ? error.name : "NonError";
  const frames = (isError ? (error.stack ?? "") : "")
    .split("\n")
    .flatMap((line) => {
      const [, file, row, column] =
        FRAME.exec(line.trim().slice(0, MAX_LINE)) ?? [];
      return file ? [`${file}:${row}:${column}`] : [];
    })
    .slice(0, MAX_FRAMES);
  return { name, frames, route };
}

/**
 * Reports uncaught errors to the native log: window `error` events and
 * unhandled rejections now, and whatever is handed to `report` (the React
 * root's callback). Install it once at startup. Repeats are dropped and
 * counted, and no more than ten reports leave a minute: one broken render must
 * not fill the log. This is not a general logger.
 */
export function installErrorReporter(options: Options = {}): ErrorReporter {
  const send = options.send ?? sendToNativeLog;
  const route = options.route ?? currentRoute;
  const now = options.now ?? Date.now;
  /** Per kind of error: when it was last sent and how many were held back since. */
  const kinds = new Map<string, { sentAt: number; held: number }>();
  let sentAt: number[] = [];

  const report = (error: unknown) => {
    try {
      const described = describe(error, route());
      const key = identity(described);
      const time = now();
      const kind = kinds.get(key) ?? { sentAt: -Infinity, held: 0 };
      sentAt = sentAt.filter((at) => time - at < WINDOW_MS);
      if (time - kind.sentAt < WINDOW_MS || sentAt.length >= MAX_PER_WINDOW) {
        kind.held += 1;
        kinds.delete(key);
        kinds.set(key, kind);
      } else {
        const count = 1 + kind.held;
        kinds.delete(key);
        kinds.set(key, { sentAt: time, held: 0 });
        sentAt.push(time);
        // Failing to report must never become another error to report.
        void Promise.resolve(send({ ...described, count })).catch(() => {});
      }
      const oldest = kinds.keys().next().value;
      if (kinds.size > MAX_KINDS && oldest !== undefined) kinds.delete(oldest);
    } catch {
      // Reporting is best effort.
    }
  };

  const onError = (event: ErrorEvent) => report(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return {
    report,
    uninstall() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    },
  };
}

let currentView = "unknown";

/** The view the person is on, which a report carries as its route. */
export function setReportedRoute(view: string) {
  currentView = view;
}

function currentRoute() {
  return currentView;
}

function sendToNativeLog(report: ErrorReport) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  return invoke("report_webview_error", { report });
}
