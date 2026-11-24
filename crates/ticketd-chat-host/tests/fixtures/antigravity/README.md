# Antigravity ACP recordings

These fixtures record the official agy 1.5.15 Apple silicon binary over ACP
stdio. The binary ran with a disposable profile and external network access
denied. For authenticated cases, a synthetic Gemini API key and a loopback
model endpoint let the native server open a Session, request tool permission
and complete Prompts. The model text, prompts and shell commands are fixture inputs.

Each line contains one JSON-RPC frame under `client` or `server`. Host paths
and process-generated Session and tool call IDs have been replaced with stable
fixture values. The three mode and resume recordings share a Session ID across
process restarts.

- `signed-out.jsonl` captures the unauthenticated session error.
- `prompt.jsonl` captures a basic Prompt and its updates.
- `question.jsonl` shows that agy 1.5.15 presents a question as a native message
  with numbered answers, followed by a Prompt reply.
- `overlapping-prompts.jsonl` shows two prompt replies and notifications
  carrying the Session ID.
- `session-modes.jsonl` captures the initial config and the server's confirmation
  of the three mode choices.
- `resume-full-access.jsonl` resumes that Session in a process launched with the
  native Full access flag. The shell Prompt runs without an ACP approval request.
- `resume-own-settings.jsonl` resumes again without the flag. The server asks
  for shell approval, which the probe cancels.
- `resume-missing-session.jsonl` captures the resume error from a different
  disposable profile that has no history for the Session.

The captures do not establish signed-in account behavior, persistent approval
scope, or shell environment propagation inside agy's sandbox.
