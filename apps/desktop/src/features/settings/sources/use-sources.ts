import { useCallback, useEffect, useRef, useState } from "react";
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
  observation: number;
  readCatalog: (() => number) | undefined;
} {
  const schedule = useSourceActivity();
  const provided = schedule.entries !== null;
  const [state, setState] = useState<{
    entries: SourceEntry[];
    loading: boolean;
    observation: number;
  }>({ entries: [], loading: true, observation: 0 });
  const generation = useRef(0);
  const readCatalog = useCallback(() => {
    const id = ++generation.current;
    void sourcesClient.list().then(
      (entries) => {
        if (id === generation.current)
          setState({ entries, loading: false, observation: id });
      },
      () => {
        if (id === generation.current)
          setState((current) => ({ ...current, loading: false }));
      },
    );
    return id;
  }, []);
  useEffect(() => {
    if (provided) return;
    readCatalog();
    return () => {
      generation.current += 1;
    };
  }, [provided, readCatalog]);
  return schedule.entries
    ? {
        entries: schedule.entries,
        loading: false,
        observation: schedule.catalogObservation ?? 0,
        readCatalog: schedule.readCatalog,
      }
    : { ...state, readCatalog };
}
