import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CheckCheck, GitBranch, GitPullRequest } from "lucide-react";
import { useOpenTicket } from "./open-ticket";
import { SourceLink } from "./SourceLink";

const proofIcons = {
  pull_request: GitPullRequest,
  verification: CheckCheck,
  branch: GitBranch,
};

export function TicketReviewProof({ onEvidence }: { onEvidence: () => void }) {
  const { value } = useOpenTicket("evidence");
  if (!value?.total) return null;
  const hidden = value.total - value.proof.length;
  return (
    <div
      className="ticket-decision-row"
      role="group"
      aria-label="Review evidence"
    >
      {value.proof.map((item) => {
        const kind = item.kind;
        if (kind === "commit" || kind === "worktree") return null;
        const Icon = proofIcons[kind];
        const content = (
          <>
            <Icon aria-hidden="true" />
            <span className="truncate">{item.name}</span>
          </>
        );
        return /^https:\/\/\S+$/.test(item.value) ? (
          <Button
            key={item.id}
            asChild
            variant="outline"
            size="compact"
            className="ticket-proof-link"
          >
            <SourceLink url={item.value} icon={false}>
              {content}
            </SourceLink>
          </Button>
        ) : (
          <Popover key={item.id}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="compact"
                className="ticket-proof-link"
              >
                {content}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" aria-label={item.name}>
              <PopoverTitle>{item.name}</PopoverTitle>
              <p className="whitespace-pre-wrap break-words">{item.value}</p>
            </PopoverContent>
          </Popover>
        );
      })}
      {hidden > 0 && (
        <Button variant="ghost" size="compact" onClick={onEvidence}>
          +{hidden} evidence
        </Button>
      )}
    </div>
  );
}
