import { progressBrief } from "./progress-brief";
import { useEffect, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { latestUpdate, type LatestUpdate as Update } from "@/lib/api/progress";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { RailSection } from "./RailSection";

export function LatestUpdate({
  reference,
  active,
  revision,
  onOpen,
}: {
  reference: string;
  active: boolean;
  revision: number;
  onOpen?: ((id: string) => void) | undefined;
}) {
  const now = useNow();
  const [state, setState] = useState<{
    update: Update | null;
    error: string;
    loading: boolean;
  }>({ update: null, error: "", loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void latestUpdate(reference)
      .then((update) => {
        if (current) setState({ update, error: "", loading: false });
      })
      .catch((error: unknown) => {
        if (current)
          setState({ update: null, error: String(error), loading: false });
      });
    return () => {
      current = false;
    };
  }, [active, reference, revision, retry]);
  const { update, error, loading } = state;
  return (
    <RailSection label="Latest update">
      {loading ? (
        <small className="rail-note">Loading update…</small>
      ) : error ? (
        <>
          <small role="alert">Could not load latest update: {error}</small>
          <Button
            variant="link"
            size="sm"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry
          </Button>
        </>
      ) : update ? (
        <div className="latest-update">
          <p className="latest-update-text">
            {progressBrief(update.brief.text)}
            {update.brief.truncated && "…"}
          </p>
          <small>
            {update.editing_agent && <>Agent: {update.editing_agent} · </>}
            <time
              tabIndex={0}
              dateTime={update.reported_at}
              title={formatDateTime(update.reported_at)}
            >
              {relativeDateTime(update.reported_at, now)}
            </time>
            {update.updated_at !== update.reported_at && (
              <>
                {" "}
                · Edited{" "}
                <time
                  tabIndex={0}
                  dateTime={update.updated_at}
                  title={formatDateTime(update.updated_at)}
                >
                  {formatDateTime(update.updated_at)}
                </time>
              </>
            )}
          </small>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpen?.(update.activity_id)}
          >
            Go to update
            <ArrowDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <small className="rail-note">No update reported</small>
      )}
    </RailSection>
  );
}
