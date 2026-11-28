import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Reference } from "@/components/ui/reference";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { AttachmentThumbnail } from "@/features/attachments/AttachmentThumbnail";
import { extensionLabel, fileType } from "@/features/attachments/file-words";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { FileWalk, usePlanOverviewFiles } from "./usePlanOverviewFiles";
import "./plan-overview-files.css";

const INITIAL_GROUPS = 3;
const THUMBNAILS_PER_GROUP = 5;

export function PlanOverviewFiles({
  archived,
  state: { groups, failure, retry, walk, setWalk, openGroup },
  onOpenTicket,
}: {
  archived: boolean;
  state: ReturnType<typeof usePlanOverviewFiles>;
  onOpenTicket: (reference: string) => void;
}) {
  const heading = useId();
  const groupsId = useId();
  const goThroughAll = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const count = groups.reduce((total, group) => total + group.files.length, 0);
  const hidden = Math.max(0, groups.length - INITIAL_GROUPS);
  return (
    <>
      {(count > 0 || failure) && (
        <section aria-labelledby={heading}>
          <div className="plan-overview-files-heading">
            <h2 className="plan-overview-section-heading flex items-center gap-1.5">
              <span id={heading}>Files</span>{" "}
              {count > 0 && <Count>{count}</Count>}
            </h2>
            {count > 0 && (
              <Button
                ref={goThroughAll}
                variant="ghost"
                size="compact"
                onClick={() => setWalk({ groups, index: 0 })}
              >
                Go through all
              </Button>
            )}
          </div>
          {failure && (
            <FailureAlert size="compact" failure={failure} onRetry={retry} />
          )}
          {!archived && count > 0 && (
            <>
              <div className="plan-overview-file-groups" id={groupsId}>
                {(expanded ? groups : groups.slice(0, INITIAL_GROUPS)).map(
                  (group) => (
                    <div key={group.reference}>
                      <h3 className="plan-overview-file-ticket text-sm">
                        <StatusIcon status={group.status} size={14} />{" "}
                        <Reference className="text-muted-foreground">
                          {group.reference}
                        </Reference>{" "}
                        <span>{group.title}</span>
                      </h3>
                      <div className="plan-overview-file-thumbnails">
                        {group.files
                          .slice(0, THUMBNAILS_PER_GROUP)
                          .map((file, index) => (
                            <Button
                              key={file.id}
                              variant="outline"
                              size="card"
                              className="plan-overview-file-tile overflow-hidden"
                              aria-label={file.display_name}
                              onClick={() => openGroup(group, index)}
                            >
                              {fileType(file.original_filename).family ===
                              "image" ? (
                                <AttachmentThumbnail file={file} size="tile" />
                              ) : (
                                extensionLabel(file.original_filename)
                              )}
                            </Button>
                          ))}
                        {group.files.length > THUMBNAILS_PER_GROUP && (
                          <Button
                            variant="outline"
                            size="card"
                            className="plan-overview-file-tile"
                            aria-label={`Show ${group.files.length - THUMBNAILS_PER_GROUP} more files for ${group.reference}`}
                            onClick={() =>
                              openGroup(group, THUMBNAILS_PER_GROUP)
                            }
                          >
                            +{group.files.length - THUMBNAILS_PER_GROUP}
                          </Button>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
              {hidden > 0 && (
                <Button
                  variant="ghost"
                  size="compact"
                  aria-expanded={expanded}
                  aria-controls={groupsId}
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded
                    ? "Show fewer tickets"
                    : `Show ${hidden} more ${hidden === 1 ? "ticket" : "tickets"}`}
                </Button>
              )}
            </>
          )}
        </section>
      )}
      {walk && (
        <PlanFileViewer
          walk={walk}
          onStep={(index) => setWalk({ ...walk, index })}
          onClose={() => setWalk(null)}
          onOpenTicket={onOpenTicket}
          fallbackFocus={() => goThroughAll.current}
        />
      )}
    </>
  );
}

function PlanFileViewer({
  walk,
  onStep,
  onClose,
  onOpenTicket,
  fallbackFocus,
}: {
  walk: FileWalk;
  onStep: (index: number) => void;
  onClose: () => void;
  onOpenTicket: (reference: string) => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const pendingTicket = useRef<string | null>(null);
  const entries = walk.groups.flatMap((group) =>
    group.files.map((file) => ({ file, group })),
  );
  const entry = entries[walk.index];
  if (!entry) return null;
  const { file, group } = entry;
  return (
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      browse={{
        files: entries.map(({ file }) => file),
        index: walk.index,
        onSelect: (_, index) => onStep(index),
      }}
      onClose={() => {
        onClose();
        if (pendingTicket.current) onOpenTicket(pendingTicket.current);
      }}
      fallbackFocus={fallbackFocus}
      source={(close) => (
        <div className="plan-overview-file-source text-sm">
          <StatusIcon status={group.status} size={14} />
          <Reference className="text-muted-foreground">
            {group.reference}
          </Reference>
          <span className="truncate">{group.title}</span>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => {
              pendingTicket.current = group.reference;
              close();
            }}
          >
            Open ticket
          </Button>
        </div>
      )}
    />
  );
}
