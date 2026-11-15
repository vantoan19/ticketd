/** Attribution is descriptive: only exact known names earn a publisher mark. */
export function editingHarness(agent: string | null | undefined) {
  const name = agent?.trim().toLowerCase();
  if (name === "codex") return "codex";
  if (name === "claude" || name === "claude-code" || name === "claude code")
    return "claude-code";
  return null;
}
