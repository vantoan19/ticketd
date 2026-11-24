import { useState } from "react";
import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PathText } from "@/components/ui/path-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";
import "./projects.css";

/** Shows the chosen folder, or that none is chosen, inside a field frame. */
export function FolderPicker({
  path,
  label,
  title,
  hint,
  onChoose,
  disabled = false,
}: {
  path: string;
  label: string;
  title: string;
  hint?: string;
  onChoose: (path: string) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState<FailureDescription | null>(null);
  async function choose() {
    try {
      const chosen = await workspaceClient.chooseFolder({ title });
      setError(null);
      if (chosen) onChoose(chosen);
    } catch (reason) {
      setError(describeFailure(reason, "open the folder picker"));
    }
  }
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="folder-picker">
        <Folder aria-hidden="true" className="folder-picker-icon" />
        <span className="folder-path" data-empty={!path}>
          {path ? <PathText path={path} layout="inline" /> : "No folder chosen"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={choose}
        >
          {path ? "Change…" : "Choose…"}
        </Button>
      </div>
      {hint && <small className="folder-hint">{hint}</small>}
      {error && (
        <FailureAlert
          size="compact"
          failure={error}
          onRetry={() => void choose()}
        />
      )}
    </Field>
  );
}
