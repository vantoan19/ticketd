import { useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { plansClient } from "@/lib/api/plans";
import { PLAN_NAME_MAX_LENGTH } from "@/lib/limits";

/**
 * Creates a Plan from its name (DialogShell sm), then opens it. The name is
 * kept when the dialog closes without creating; a failure stays in the
 * dialog with Retry.
 */
export function NewPlanDialog({
  open,
  onOpenChange,
  refresh,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  async function create() {
    const trimmed = name.trim();
    setPending(true);
    setFailure(null);
    try {
      const { id } = await plansClient.create(trimmed);
      await refresh();
      setName("");
      onOpenChange(false);
      onCreated(id);
    } catch (reason) {
      setFailure(describeFailure(reason, `create ${trimmed}`));
    } finally {
      setPending(false);
    }
  }
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => {
        if (!next) setFailure(null);
        onOpenChange(next);
      }}
      size="sm"
      title="New Plan"
      description="A Plan groups the tickets that ship together."
      primaryLabel="Create Plan"
      blockedReason={
        pending
          ? "Creating…"
          : name.trim()
            ? null
            : "Name the Plan to create it."
      }
      busy={pending}
      error={
        failure && (
          <FailureAlert
            size="compact"
            failure={failure}
            onRetry={() => void create()}
          />
        )
      }
      onCancel={() => setName("")}
      onSubmit={() => void create()}
    >
      <Field>
        <FieldLabel htmlFor="new-plan-name">Name</FieldLabel>
        <Input
          id="new-plan-name"
          value={name}
          autoComplete="off"
          placeholder="e.g. Board polish"
          maxLength={PLAN_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </DialogShell>
  );
}
