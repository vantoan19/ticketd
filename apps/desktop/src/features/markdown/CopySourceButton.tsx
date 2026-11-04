import { useState } from "react";
import { Copy } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

export function CopySourceButton({
  source,
  label,
}: {
  source: string;
  label: string;
}) {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setMessage("Copied");
    } catch {
      setMessage("Copy unavailable. Select and copy the source instead.");
    }
  }
  return (
    <>
      <IconButton type="button" label={label} onClick={() => void copy()}>
        <Copy aria-hidden="true" />
      </IconButton>
      <span role="status" className="text-muted-foreground text-xs">
        {message}
      </span>
    </>
  );
}
