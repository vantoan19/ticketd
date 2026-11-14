import { useEffect, useEffectEvent, useState, type KeyboardEvent } from "react";

/**
 * A number field for a whole number from 1 to `most`, committed when it is
 * finished: on leaving the field, on Enter, or when the field goes away with
 * one typed. Each digit on the way is not committed, so typing 501 never
 * stores 50. Anything else typed is not committed: `invalid` says so while it
 * is typed, and leaving the field shows `value` again.
 */
export function useWholeNumber({
  value,
  most,
  onCommit,
}: {
  value: number;
  most: number;
  onCommit: (value: number) => void;
}) {
  /** What is typed and not committed yet; null shows `value`. */
  const [text, setText] = useState<string | null>(null);
  // A value changed from outside (taken from elsewhere) replaces the typing.
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setText(null);
  }
  const typed = text === null ? null : Number(text);
  const valid =
    typed !== null && Number.isInteger(typed) && typed >= 1 && typed <= most;
  /** Commits what is typed when it is a new value; says whether it was valid. */
  const commit = () => {
    if (valid && typed !== value) onCommit(typed);
    return valid;
  };
  // Typed just before the form closes, it is still kept.
  const commitOnLeaving = useEffectEvent(commit);
  useEffect(() => () => void commitOnLeaving(), []);
  return {
    invalid: typed !== null && !valid,
    inputProps: {
      type: "number",
      min: 1,
      max: most,
      step: 1,
      value: text ?? (value ? String(value) : ""),
      onChange: (event: { target: { value: string } }) =>
        setText(event.target.value),
      onBlur: () => {
        commit();
        setText(null);
      },
      // Enter on something that is not a limit keeps it, and the note, to correct.
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter" && commit()) setText(null);
      },
    },
  };
}
