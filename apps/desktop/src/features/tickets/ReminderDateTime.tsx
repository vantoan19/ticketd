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
  past,
  onDraft,
  onOccurrence,
}: {
  reference: string;
  draft: string;
  occurrence: string;
  pending: boolean;
  past: boolean;
  onDraft: (value: string) => void;
  onOccurrence: (value: string) => void;
}) {
  const options = localInstants(draft);
  const skipped = complete(draft) && options.length === 0;
  const invalid = skipped || past;
  return (
    <Field
      data-invalid={invalid || undefined}
      data-disabled={pending || undefined}
    >
      <FieldLabel htmlFor={`reminder-time-${reference}`}>
        Date and time
      </FieldLabel>
      <Input
        id={`reminder-time-${reference}`}
        type="datetime-local"
        disabled={pending}
        value={draft}
        aria-invalid={invalid || undefined}
        aria-describedby={
          invalid
            ? `reminder-time-error-${reference}`
            : `reminder-zone-${reference}`
        }
        onChange={(event) => onDraft(event.target.value)}
      />
      {invalid ? (
        <FieldError id={`reminder-time-error-${reference}`}>
          {skipped
            ? "The clock skips this time here. Choose another time."
            : "This time has passed. Choose a future time."}
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
