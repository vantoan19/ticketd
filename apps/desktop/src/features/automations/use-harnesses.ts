import { useEffect, useState } from "react";
import { useChatClient, type HarnessStatus } from "@/features/chats/client";

type Status = HarnessStatus["status"];
type Found = HarnessStatus[] | "failed";

/**
 * The last answer of the harness check, kept for the page's lifetime: a form
 * opened again shows it while asking again, not "Checking…" each time.
 */
let lastFound: Found | null = null;

/**
 * How each harness stands on this computer, by id: undefined until the first
 * check answers, "unknown" when the check itself failed, "not_installed" for
 * one the check did not list.
 */
export function useHarnessStatus(): (id: string) => Status | undefined {
  const client = useChatClient();
  const [found, setFound] = useState(lastFound);
  useEffect(() => {
    let current = true;
    const take = (next: Found) => {
      // A failed check is not remembered: the next form asks afresh.
      lastFound = next === "failed" ? lastFound : next;
      if (current) setFound(next);
    };
    client.harnesses().then(take, () => take("failed"));
    return () => {
      current = false;
    };
  }, [client]);
  return (id) =>
    found === null
      ? undefined
      : found === "failed"
        ? "unknown"
        : (found.find((item) => item.id === id)?.status ?? "not_installed");
}

/** What a harness tile says about this computer, and whether it can be chosen. */
export function harnessStanding(status: Status | undefined): {
  label: string;
  tone: "positive" | "attention" | "neutral";
  usable: boolean;
} {
  switch (status) {
    case undefined:
      return { label: "Checking…", tone: "neutral", usable: true };
    case "ready":
    case "not_subscription":
    case "sign_in_unknown":
      return { label: "Ready", tone: "positive", usable: true };
    case "not_signed_in":
      return { label: "Not signed in", tone: "attention", usable: true };
    case "unknown":
      return { label: "Could not check", tone: "neutral", usable: true };
    case "not_installed":
      return { label: "Not installed", tone: "neutral", usable: false };
    case "incompatible":
      return { label: "Needs an update", tone: "neutral", usable: false };
    case "unavailable":
      return { label: "Not available", tone: "neutral", usable: false };
  }
}
