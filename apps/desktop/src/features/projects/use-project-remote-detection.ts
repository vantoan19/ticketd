import { useEffect, useState } from "react";
import { client, type ProjectRemoteDetection } from "@/lib/api/client";

const NO_REMOTE: ProjectRemoteDetection = { suggested: null, candidates: [] };

/** Detection is optional. Each visit to a path needs its own result. */
export function useProjectRemoteDetection(path: string) {
  const [request, setRequest] = useState({ path });
  if (request.path !== path) setRequest({ path });

  const [result, setResult] = useState<{
    request: typeof request;
    detection: ProjectRemoteDetection;
  } | null>(null);
  useEffect(() => {
    if (!request.path) return;
    let current = true;
    void client.detectProjectRemote(request.path).then(
      (detection) => {
        if (current) setResult({ request, detection });
      },
      () => {
        if (current) setResult({ request, detection: NO_REMOTE });
      },
    );
    return () => {
      current = false;
    };
  }, [request]);
  const detection = result?.request === request ? result.detection : null;
  return {
    detection: detection ?? NO_REMOTE,
    pending: Boolean(path && !detection),
  };
}
