import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { draftRetention, type DraftRetention } from "./api/attachments";
import { Button } from "@/components/ui/button";
import {
  DraftRecoveryContext as Context,
  DraftRecoveryErrorContext as ErrorContext,
  type DraftRecovery,
} from "./draft-recovery-context";

function recoveryStore(
  initial: DraftRetention[],
  onError: (error: string) => void,
) {
  const records = new Map(initial.map((record) => [record.owner, record]));
  const visible = new Map(
    initial.map((record) => [record.owner, record.payload]),
  );
  const queue: (() => Promise<void>)[] = [];
  let running: Promise<void> | null = null;
  let error: unknown = null;
  const pump = (): Promise<void> => {
    if (running) return running;
    if (error) return Promise.reject(error);
    running = (async () => {
      while (queue.length) {
        await queue[0]?.();
        queue.shift();
      }
    })()
      .catch((reason) => {
        error = reason;
        onError(String(reason));
        throw reason;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const flush = async () => {
    while (queue.length || running) {
      if (error) throw error;
      await pump();
    }
    if (error) throw error;
  };
  const store: DraftRecovery & {
    retry: () => void;
    has: (owner: string) => boolean;
  } = {
    active: true,
    has: (owner) => visible.has(owner),
    read(owner, schema) {
      const payload = visible.get(owner);
      return payload == null ? null : schema.parse(payload);
    },
    put(owner, payload, markdown, kind = "draft") {
      visible.set(owner, payload);
      queue.push(async () => {
        const previous = records.get(owner);
        // Do not create empty recovery records on every untouched editor mount.
        if (!previous && payload == null && !markdown.length) return;
        if (
          previous &&
          JSON.stringify([
            previous.payload,
            previous.markdown,
            previous.kind,
          ]) === JSON.stringify([payload, markdown, kind])
        )
          return;
        const saved = await draftRetention.retain({
          owner,
          kind,
          revision: previous?.revision ?? 0,
          payload,
          markdown,
        });
        records.set(owner, saved);
      });
      const pending = flush();
      // Callers that deliberately await flush see the error; background edits show the banner.
      void pending.catch(() => {});
      return pending;
    },
    flush,
    retry() {
      error = null;
      onError("");
      void flush().catch(() => {});
    },
  };
  return store;
}

/** Load core recovery before mounting editors; all payloads are workspace-local and backed up. */
export function DraftRecoveryProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<ReturnType<typeof recoveryStore> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [cutoverPending, setCutoverPending] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const next = recoveryStore(await draftRetention.list(), (message) => {
        if (active) setError(message);
      });
      const importLegacy = async (
        owner: string,
        payload: unknown,
        markdown: string[],
      ) => {
        if (next.has(owner)) {
          if (
            JSON.stringify(next.read(owner, z.unknown())) ===
            JSON.stringify(payload)
          )
            return;
          // Another profile may have distinct prose under the same old key.
          // Preserve it separately instead of replacing the primary core recovery.
          let profile = localStorage.getItem("ticketd:legacy-recovery-profile");
          if (!profile) {
            profile = crypto.randomUUID();
            localStorage.setItem("ticketd:legacy-recovery-profile", profile);
          }
          owner = `legacy:${profile}:${owner}`;
        }
        await next.put(owner, payload, markdown);
      };
      // Consume every legacy browser draft, including unopened tickets. Never release bytes
      // just because the originating desktop was closed during the format upgrade.
      for (const key of Object.keys(localStorage)) {
        const match = /^ticketd:(ticket|activity)-draft:(.+)$/.exec(key);
        if (!match) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { brief: raw, details: null, support: "" };
        }
        if (match[1] === "activity") {
          const old = z
            .object({
              brief: z.string().optional(),
              details: z.string().nullable().optional(),
              support: z.string().optional(),
            })
            .passthrough()
            .parse(typeof payload === "object" ? payload : { brief: raw });
          payload = {
            ...old,
            brief: old.brief ?? "",
            details:
              old.details ??
              localStorage.getItem(`ticketd:activity-details:${match[2]}`),
            support:
              old.support ||
              localStorage.getItem(`ticketd:activity-support:${match[2]}`) ||
              "",
          };
        }
        const fields = z
          .object({
            body: z.string().optional(),
            brief: z.string().optional(),
            details: z.string().nullable().optional(),
          })
          .passthrough()
          .parse(payload);
        const owner = `${match[1]}:${match[2]}`;
        await importLegacy(
          owner,
          payload,
          [fields.body ?? "", fields.brief ?? "", fields.details ?? ""].filter(
            Boolean,
          ),
        );
        localStorage.removeItem(key);
        if (match[1] === "activity") {
          localStorage.removeItem(`ticketd:activity-details:${match[2]}`);
          localStorage.removeItem(`ticketd:activity-support:${match[2]}`);
        }
      }
      // Older Activity releases stored details/support without a draft object.
      for (const key of Object.keys(localStorage)) {
        const match = /^ticketd:activity-(details|support|request):(.+)$/.exec(
          key,
        );
        if (!match) continue;
        const id = match[2];
        if (match[1] === "request") {
          const owner = `ticketd:activity-request:${id}`;
          await importLegacy(
            owner,
            JSON.parse(localStorage.getItem(key) ?? "null") as unknown,
            [],
          );
        } else {
          const owner = `activity:${id}`;
          if (localStorage.getItem(key) !== null) {
            const details = localStorage.getItem(
              `ticketd:activity-details:${id}`,
            );
            const support =
              localStorage.getItem(`ticketd:activity-support:${id}`) ?? "";
            await importLegacy(
              owner,
              { brief: "", details, support },
              details ? [details] : [],
            );
            localStorage.removeItem(`ticketd:activity-details:${id}`);
            localStorage.removeItem(`ticketd:activity-support:${id}`);
          }
        }
        localStorage.removeItem(key);
      }
      const pending = await draftRetention.cutoverPending();
      if (active) {
        setCutoverPending(pending);
        setStore(next);
        setError("");
      }
    })().catch((reason) => {
      if (active) setError(String(reason));
    });
    return () => {
      active = false;
    };
  }, [attempt]);
  return (
    <>
      {cutoverPending && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-xl rounded-md border bg-(--surface) p-4 shadow-lg"
        >
          Files are protected while legacy drafts are reviewed. Open each
          desktop profile to import its drafts before allowing cleanup.{" "}
          <Button
            onClick={() =>
              void draftRetention
                .completeCutover()
                .then(() => setCutoverPending(false))
                .catch((reason) => setError(String(reason)))
            }
          >
            All desktop profiles reviewed
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="fixed inset-x-4 top-4 z-40 mx-auto max-w-xl rounded-md border bg-(--surface) p-4 shadow-lg"
        >
          Could not protect recoverable drafts. Keep this window open. {error}{" "}
          <Button
            onClick={() =>
              store ? store.retry() : setAttempt((value) => value + 1)
            }
          >
            Retry draft recovery
          </Button>
        </div>
      )}
      {store ? (
        <ErrorContext.Provider value={error}>
          <Context.Provider value={store}>{children}</Context.Provider>
        </ErrorContext.Provider>
      ) : (
        <p role="status">Loading recoverable drafts…</p>
      )}
    </>
  );
}
