import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

/** A refused Chat action and how to repeat it, for a compact FailureAlert. */
export type ChatFailureNotice = {
  failure: FailureDescription;
  retry?: () => void;
};

/** Describes a refused Chat action; `retry` repeats it when that can help. */
export function chatFailure(
  reason: unknown,
  action: string,
  retry?: () => void,
): ChatFailureNotice {
  return {
    failure: describeFailure(reason, action),
    ...(retry && { retry }),
  };
}
