import { StatusIcon } from "@/features/tickets/StatusIcon";
import { diffWords } from "./text-diff";

/**
 * One field's value as the comparison shows it. With `against`, the words this
 * value has that the other lacks are marked: `ins` underlines them, `del`
 * strikes them through for a value that was since replaced.
 */
export function FieldValue({
  field,
  value,
  against,
  mark = "ins",
}: {
  field: string;
  value: string;
  against?: string;
  mark?: "ins" | "del";
}) {
  if (field === "status")
    return (
      <span className="sync-value">
        <StatusIcon status={value} decorative />
        {value}
      </span>
    );
  if (field !== "body") return <span className="sync-value">{value}</span>;
  const Mark = mark;
  const parts =
    against === undefined
      ? [{ text: value, changed: false }]
      : diffWords(value, against).before;
  return (
    // ponytail: Markdown source with the changed words marked, not rendered
    // Markdown; render it once a diff over the rendered tree is worth building.
    <span className="sync-body">
      {parts.map((part, index) =>
        part.changed && part.text.trim() ? (
          <Mark key={index}>{part.text}</Mark>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
