import { useEffect, useState } from "react";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { sourcesClient, type SourceEntry } from "@/lib/api/sources";

/**
 * The sources this build offers. Settings shows a source only once the core has
 * reported its connector, so nothing appears while loading or when the list
 * cannot be read. The workspace reads the list once for every view; a view
 * rendered alone reads it itself.
 */
export function useSources(): {
  entries: SourceEntry[];
  loading: boolean;
} {
  const provided = useSourceActivity().entries;
  const [state, setState] = useState<{
    entries: SourceEntry[];
    loading: boolean;
  }>({ entries: [], loading: true });
  useEffect(() => {
    if (provided) return;
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
  }, [provided]);
  return provided ? { entries: provided, loading: false } : state;
}
