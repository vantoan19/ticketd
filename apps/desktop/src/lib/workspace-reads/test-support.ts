import { act, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach } from "vitest";
import type { ChangeSignal } from "./change-signal";
import { fakeChangeSignal } from "./fake-signal";
import { TestReads } from "./testing";

/** A call a test resolves by hand, in the order it chooses. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A renderHook wrapper: fresh reads driven by `signal`. */
export const wrap =
  (signal: ChangeSignal = fakeChangeSignal()) =>
  ({ children }: { children: ReactNode }) =>
    createElement(TestReads, { signal, children });

/** Lets pending promise callbacks and query notifications run. */
export const settle = () => act(async () => {});

// Vitest runs without globals, so Testing Library does not unmount by itself,
// and a test would find the previous one's DOM. Importing this file (every
// test of this module does) registers the cleanup once for its file.
afterEach(cleanup);
