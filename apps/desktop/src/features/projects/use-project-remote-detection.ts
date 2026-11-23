import { useEffect, useState } from "react";
import { client, type ProjectRemoteDetection } from "@/lib/api/client";

const NO_REMOTE: ProjectRemoteDetection = { suggested: null, candidates: [] };

/** Detection is optional, and a response for an old path never supplies a draft. */
export function useProjectRemoteDetection(path: string) {
  const [result, setResult] = useState<{
    path: string;
    detection: ProjectRemoteDetection;
  } | null>(null);
  useEffect(() => {
    if (!path) return;
    let current = true;
    void client.detectProjectRemote(path).then(
      (detection) => {
        if (current) setResult({ path, detection });
      },
      () => {
        if (current) setResult({ path, detection: NO_REMOTE });
      },
    );
    return () => {
      current = false;
    };
  }, [path]);
  return {
    detection: path && result?.path === path ? result.detection : NO_REMOTE,
    pending: Boolean(path && result?.path !== path),
  };
}
