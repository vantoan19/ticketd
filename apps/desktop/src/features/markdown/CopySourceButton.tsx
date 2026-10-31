import { useState } from "react";
import { Button } from "@/components/ui/button";

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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
      >
        {label}
      </Button>
      <span role="status" className="text-muted-foreground text-xs">
        {message}
      </span>
    </>
  );
}
