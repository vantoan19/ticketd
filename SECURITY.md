# Security policy

## Report a vulnerability privately

Email [toan.tran.cqt@gmail.com](mailto:toan.tran.cqt@gmail.com) with the subject
`ticketd security report`. Do not post vulnerability details in public issues,
pull requests, or discussions.

When available, you can instead use this repository's **Security → Report a
vulnerability** form. If that option is absent, use the email address above.
No response-time or bounty commitment is currently offered.

Include the following in a private report:

- Affected version or commit, operating system, and installation method.
- Minimal reproduction steps using synthetic data.
- Expected and actual behavior, and the potential impact.
- Access required to exploit the problem and any relevant configuration.

Exclude real credentials, private workspaces, and customer data. A small sanitized
proof of concept is more useful than a full database or backup.

## Scope

Relevant areas include the desktop's native command boundary, local file and
attachment access, Markdown rendering, imports/restores, credential handling,
and GitHub/Google Drive integrations. Report ways untrusted content can cross
those boundaries or disclose data without the user's intended action.

For a third-party vulnerability, notify the upstream maintainer as well when
appropriate. Explain how ticketd's use of that dependency is affected.

## Supported versions and disclosure

ticketd is in early development and has not established a stable-release support
window. Include the exact affected commit or version; if possible, check whether
the issue also exists on current `main`. Do not risk personal data to reproduce it.

Please coordinate disclosure so maintainers have an opportunity to investigate
and provide a fix. Agree on publication and attribution with the reporter; do
not assume that filing a report grants permission to publish identifying details.
