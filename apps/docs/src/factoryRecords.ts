// Launch-story fixtures. These examples are local and never contact an agent,
// storage provider or sync service. Captured desktop views remain separate.
export const contextRecords = {
  spec: {
    title: "Login hardening spec",
    kind: "Document · shared specification",
    body: "Limit repeated failed logins per account and IP address. Allow five failed attempts per fifteen minutes, then return 429 with a Retry-After header. Alert the on-call team when failed logins spike.",
    detail:
      "One specification supports both rate limiting and alerting. A new session starts with the same requirements.",
    tickets: [
      "T-12 · Rate-limit failed login attempts",
      "T-13 · Alert on-call when failed logins spike",
    ],
  },
  notes: {
    title: "Login abuse notes",
    kind: "Document · investigation",
    body: "Repeated attempts came from both a single IP and rotating IPs. Check both the account and the source address. Avoid a permanent lockout that could prevent the real owner from signing in.",
    detail:
      "Keep the reasoning beside the work so an agent can explain its choices.",
    tickets: ["T-12 · Rate-limit failed login attempts"],
  },
  update: {
    title: "Latest agent update",
    kind: "Activity · coding-agent · 00:24",
    body: "Limiter tests pass on CI. Opened #87 for review.",
    detail:
      "The report stays on T-12, with its author and the change to In review.",
    tickets: ["T-12 · Rate-limit failed login attempts"],
  },
  evidence: {
    title: "Pull request #87 & CI",
    kind: "Evidence · Git & checks",
    body: "feat/login-rate-limit → Pull request #87. The limiter checks pass. The implementation is ready for a person to review.",
    detail: "Follow a claim back to the work that supports it.",
    tickets: ["T-12 · Rate-limit failed login attempts"],
  },
} as const;
export type ContextKey = keyof typeof contextRecords;

export const contextKeys: ContextKey[] = [
  "spec",
  "notes",
  "update",
  "evidence",
];
