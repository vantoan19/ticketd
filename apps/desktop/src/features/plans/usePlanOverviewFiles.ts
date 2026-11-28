import { useMemo, useState } from "react";
import { plansClient, type PlanTicketFiles } from "@/lib/api/plans";
import { read, skip, useRead } from "@/lib/workspace-reads";
import type { PlanOverviewWork } from "./PlanOverview";

const planFilesRead = read({
  key: "plan-files",
  call: plansClient.files,
  failure: "load the Plan's files",
});

export type FileWalk = {
  groups: readonly PlanTicketFiles[];
  index: number;
};

export function usePlanOverviewFiles(
  id: string | null,
  work: PlanOverviewWork | null,
) {
  const { value, failure, retry } = useRead(planFilesRead, id ?? skip);
  const byTicket = useMemo(
    () => new Map(value?.map((group) => [group.reference, group])),
    [value],
  );
  const groups = useMemo(() => {
    const remaining = new Map(byTicket);
    const inOverviewOrder = Object.values(work?.sections ?? {}).flatMap(
      (items) =>
        items.flatMap(({ ticket }) => {
          const group = remaining.get(ticket.reference);
          if (!group) return [];
          remaining.delete(ticket.reference);
          return [group];
        }),
    );
    // The Overview's member window can be bounded. Keep the rest of the files walkable.
    return [...inOverviewOrder, ...remaining.values()];
  }, [byTicket, work]);
  const [walk, setWalk] = useState<FileWalk | null>(null);
  return {
    byTicket,
    groups,
    failure,
    retry,
    walk,
    setWalk,
    openGroup: (group: PlanTicketFiles, index = 0) =>
      setWalk({ groups: [group], index }),
  };
}
