import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "@/lib/clipboard";

/**
 * Copies text and reports the result for a short confirmation. `copied` holds
 * the label of what was just copied; `error` explains a failure.
 */
export function useCopy() {
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy(label: string, text: string): Promise<boolean> {
    const failure = await writeClipboard(text);
    window.clearTimeout(timer.current);
    if (failure === null) {
      setError("");
      setCopied(label);
      timer.current = window.setTimeout(() => setCopied(""), 2000);
      return true;
    }
    setCopied("");
    setError(`Couldn't copy ${label.toLowerCase()}: ${failure}.`);
    return false;
  }
  return { copied, error, copy };
}
