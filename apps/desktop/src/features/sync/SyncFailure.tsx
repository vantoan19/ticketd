import { FailureAlert } from "@/components/ui/failure-alert";
import { FieldError } from "@/components/ui/field";
import type { FailureDescription } from "@/lib/api/describe-failure";

/**
 * A command that failed (compact error Alert with Details), or a value that
 * cannot be saved (a field message, nothing sent).
 */
export function SyncFailure({
  children,
  onRetry,
}: {
  children: FailureDescription | string | null;
  onRetry?: () => void;
}) {
  if (!children) return null;
  return typeof children === "string" ? (
    <FieldError className="mt-3">{children}</FieldError>
  ) : (
    <FailureAlert
      size="compact"
      failure={children}
      className="mt-3"
      {...(onRetry && { onRetry })}
    />
  );
}
