import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { formatTime } from "@/lib/format";
import {
  complete,
  localInstants,
  offsetLabel,
  zoneLabel,
} from "./reminder-time";

/** The same zone-aware custom time field in the reminder and palette. */
export function ReminderDateTime({
  reference,
  draft,
  occurrence,
  pending,
  onDraft,
  onOccurrence,
}: {
  reference: string;
  draft: string;
  occurrence: string;
  pending: boolean;
  onDraft: (value: string) => void;
  onOccurrence: (value: string) => void;
}) {
  const options = localInstants(draft);
  const skipped = complete(draft) && options.length === 0;
  return (
    <Field>
      <FieldLabel htmlFor={`reminder-time-${reference}`}>
        Date and time
      </FieldLabel>
      <Input
        id={`reminder-time-${reference}`}
        type="datetime-local"
        disabled={pending}
        value={draft}
        aria-invalid={skipped || undefined}
        aria-describedby={
          skipped
            ? `reminder-time-error-${reference}`
            : `reminder-zone-${reference}`
        }
        onChange={(event) => onDraft(event.target.value)}
      />
      {skipped ? (
        <FieldError id={`reminder-time-error-${reference}`}>
          The clock skips this time here. Choose another time.
        </FieldError>
      ) : (
        <FieldDescription id={`reminder-zone-${reference}`}>
          {zoneLabel(new Date())}
        </FieldDescription>
      )}
      {options.length > 1 && (
        <Picker
          stacked
          label="Clock change"
          value={occurrence || "none"}
          disabled={pending}
          onValueChange={(value) => onOccurrence(value === "none" ? "" : value)}
          options={[
            ...(occurrence
              ? []
              : [{ value: "none", label: "Choose which one" }]),
            ...options.map((date) => ({
              value: date.toISOString(),
              label: `${formatTime(date)} (${offsetLabel(date)})`,
            })),
          ]}
        />
      )}
    </Field>
  );
}
