import type { ChangeSignal } from "./change-signal";

/** A change signal a test moves by hand. */
export type FakeChangeSignal = ChangeSignal & {
  /** Reports that the Workspace changed, as a poll that saw a new token would. */
  change(): void;
  /** How many times `catchUp` was called. */
  readonly catchUps: number;
  /** How many times `forget` was called. */
  readonly forgets: number;
};

/**
 * `catchUp` resolves at once unless the test passes its own, for example to
 * hold it and look at what happens before the token has been read.
 */
export function fakeChangeSignal(
  catchUp: () => Promise<void> = () => Promise.resolve(),
): FakeChangeSignal {
  const listeners = new Set<() => void>();
  let catchUps = 0;
  let forgets = 0;
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    catchUp() {
      catchUps += 1;
      return catchUp();
    },
    forget() {
      forgets += 1;
    },
    change() {
      for (const listener of [...listeners]) listener();
    },
    get catchUps() {
      return catchUps;
    },
    get forgets() {
      return forgets;
    },
  };
}
