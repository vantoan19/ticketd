import { changesClient } from "@/lib/api/changes";

/**
 * How the reads module learns that the Workspace changed. `subscribe` calls
 * `onChange` each time the core's change token moved since the last time it was
 * seen; `catchUp` reads the token now and counts it as seen, so a write the
 * desktop made itself does not start a second wave when the next poll arrives.
 */
export type ChangeSignal = {
  subscribe(onChange: () => void): () => void;
  catchUp(): Promise<void>;
  /**
   * The Workspace was replaced: forget what was seen, so the next poll counts as
   * a change even if the new token equals the old one.
   */
  forget(): void;
};

const POLL_MS = 2000;

/**
 * The production signal: one poll of the core's single change token every two
 * seconds, so changes made by the CLI or an agent reach the screen within that
 * time while views never poll on their own. It polls only while someone is
 * subscribed, and keeps polling when the window is minimized because the core
 * delivers due reminders when the token is read.
 */
export function pollWorkspaceChanges(everyMs = POLL_MS): ChangeSignal {
  const listeners = new Set<() => void>();
  let last: number | null = null;
  let forgotten = false;
  let timer: number | undefined;
  // Answers can arrive out of order; only a newer read may replace `last`.
  let sent = 0;
  let applied = 0;

  /** Reads the token; resolves true when it moved since the last one applied. */
  const read = async (): Promise<boolean> => {
    const order = ++sent;
    const token = await changesClient.token();
    if (order < applied) return false;
    applied = order;
    const moved = forgotten || (last !== null && token !== last);
    forgotten = false;
    last = token;
    return moved;
  };

  const poll = () =>
    void read()
      .then((moved) => {
        if (moved) for (const listener of [...listeners]) listener();
      })
      .catch(() => {});

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) {
        poll();
        timer = window.setInterval(poll, everyMs);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          window.clearInterval(timer);
          last = null;
        }
      };
    },
    async catchUp() {
      await read();
    },
    forget() {
      forgotten = true;
    },
  };
}
