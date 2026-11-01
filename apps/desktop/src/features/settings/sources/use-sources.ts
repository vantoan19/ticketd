import { useEffect, useState } from "react";
import { sourcesClient, type SourceEntry } from "@/lib/api/sources";

/**
 * The sources this build offers. Settings shows a source only once the core has
 * reported its connector, so nothing appears while loading or when the list
 * cannot be read.
 */
export function useSources(): {
  entries: SourceEntry[];
  loading: boolean;
} {
  const [state, setState] = useState<{
    entries: SourceEntry[];
    loading: boolean;
  }>({ entries: [], loading: true });
  useEffect(() => {
    let current = true;
    sourcesClient
      .list()
      .then((entries) => {
        if (current) setState({ entries, loading: false });
      })
      .catch(() => {
        if (current) setState({ entries: [], loading: false });
      });
    return () => {
      current = false;
    };
  }, []);
  return state;
}
