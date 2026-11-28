import { useCallback, useEffect, useRef, useState } from "react";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { getGithubIntegration, type GithubIntegration } from "@/lib/api/github";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { sourcesClient, type SourceEntry } from "@/lib/api/sources";

/**
 * The sources this build offers. Settings shows a source only once the core has
 * reported its connector, so nothing appears while loading or when the list
 * cannot be read. The workspace reads the list once for every view; a view
 * rendered alone reads it itself.
 */
export function useSources(): {
  entries: SourceEntry[];
  github: GithubIntegration | null;
  loading: boolean;
  catalogFailure: FailureDescription | null;
  githubFailure: FailureDescription | null;
  readCatalog: (() => void) | undefined;
} {
  const schedule = useSourceActivity();
  const provided = schedule.entries !== null;
  const providedGithub = schedule.github !== undefined;
  const [state, setState] = useState<{
    entries: SourceEntry[];
    github: GithubIntegration | null;
    loading: boolean;
    catalogFailure: FailureDescription | null;
    githubFailure: FailureDescription | null;
  }>({
    entries: [],
    github: null,
    loading: true,
    catalogFailure: null,
    githubFailure: null,
  });
  const generation = useRef(0);
  const readCatalog = useCallback(() => {
    const id = ++generation.current;
    if (!provided) {
      void sourcesClient.list().then(
        (entries) => {
          if (id === generation.current)
            setState((current) => ({
              ...current,
              entries,
              loading: false,
              catalogFailure: null,
            }));
        },
        (reason: unknown) => {
          if (id === generation.current)
            setState((current) => ({
              ...current,
              loading: false,
              catalogFailure: describeFailure(reason, "load ticket sources"),
            }));
        },
      );
    }
    void getGithubIntegration().then(
      (github) => {
        if (id === generation.current)
          setState((current) => ({ ...current, github, githubFailure: null }));
      },
      (reason: unknown) => {
        if (id === generation.current)
          setState((current) => ({
            ...current,
            githubFailure: describeFailure(reason, "load GitHub settings"),
          }));
      },
    );
    return id;
  }, [provided]);
  useEffect(() => {
    if (providedGithub) return;
    readCatalog();
    return () => {
      generation.current += 1;
    };
  }, [providedGithub, readCatalog]);
  return schedule.entries
    ? {
        entries: schedule.entries,
        github: schedule.github === undefined ? state.github : schedule.github,
        loading: schedule.catalogLoading ?? false,
        catalogFailure: schedule.catalogFailure ?? null,
        githubFailure: providedGithub
          ? (schedule.githubFailure ?? null)
          : state.githubFailure,
        readCatalog: providedGithub
          ? schedule.readCatalog
          : (schedule.readCatalog ?? readCatalog),
      }
    : { ...state, readCatalog };
}
