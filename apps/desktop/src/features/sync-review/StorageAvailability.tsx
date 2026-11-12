import { Progress } from "@/components/ui/progress";
import type { Availability } from "@/lib/sync-review-api";
import { storageWord } from "./availability";
import "./sync-review.css";

/** The Storage value of a managed Attachment, with its progress while downloading. */
export function StorageAvailability({
  name,
  availability,
}: {
  name: string;
  availability: Availability | undefined;
}) {
  if (availability?.state !== "downloading") return storageWord(availability);
  return (
    <span className="sync-availability">
      <Progress
        aria-label={`Downloading ${name}`}
        value={availability.progress}
      />
      Downloading…
    </span>
  );
}
