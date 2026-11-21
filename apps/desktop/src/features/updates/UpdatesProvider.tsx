import { useCallback, useEffect, useState, type ReactNode } from "react";
import { updateClient, type UpdateInfo, type UpdateSnapshot } from "./client";
import { RestartUpdateDialog } from "./RestartUpdateDialog";
import { initialUpdateState, UpdatesContext } from "./update-state";

export function UpdatesProvider({
  children,
  beforeInstall,
}: {
  children: ReactNode;
  beforeInstall: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState(initialUpdateState);
  const [prompt, setPrompt] = useState<UpdateInfo | null>(null);
  // The event and the initial IPC read can arrive in either order.
  const apply = useCallback((next: UpdateSnapshot) => {
    setSnapshot((current) =>
      next.revision > current.revision ? next : current,
    );
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let stopped = false;
    let cleanup: (() => void) | undefined;
    const changed = (next: UpdateSnapshot) => {
      if (!stopped) apply(next);
    };
    void updateClient
      .listen(changed)
      .then((unlisten) => {
        if (stopped) return unlisten();
        cleanup = unlisten;
        return updateClient.state().then(changed);
      })
      .catch(() => {});
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, [apply]);

  return (
    <UpdatesContext
      value={{
        snapshot,
        openRestart: setPrompt,
        setAutomatic: async (enabled) =>
          apply(await updateClient.setAutomatic(enabled)),
        dismiss: updateClient.dismiss,
      }}
    >
      {children}
      {prompt && (
        <RestartUpdateDialog
          key={prompt.version}
          update={prompt}
          beforeInstall={beforeInstall}
          onClose={() => setPrompt(null)}
        />
      )}
    </UpdatesContext>
  );
}
