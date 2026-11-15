import type { FailureDescription } from "@/lib/api/describe-failure";

/**
 * The layout worker failed: an internal error, so its text is only for
 * Details. Drawing again usually works.
 */
export function layoutFailure(details: string): FailureDescription {
  return {
    code: "failed",
    title: "Couldn't lay out the graph",
    sentence: "Its layout stopped early. Retry to draw it again.",
    action: "retry",
    details,
  };
}
