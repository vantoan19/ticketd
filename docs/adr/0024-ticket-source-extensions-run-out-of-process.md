# Ticket source extensions run out of process

## Context

The connector interface began as an internal Rust interface with GitHub Issues
as its only production adapter. Each additional tracker would require a ticketd
release, and people could configure only one account or site per provider.
The goal is to let people connect their own trackers and to make it faster to
ship first-party sources. [Issue #562](https://github.com/vantoan19/ticketd/issues/562)

## Decision

ticketd starts each ticket source extension as a separate executable and talks
to it over standard input and output using JSON-RPC 2.0, one message per line.
Authors can use any language and ship their programs independently of ticketd.
A process adapter implements the same connector interface as the built-in GitHub
adapter, so both use the same ticket workflows. ticketd owns persistence,
scheduling, and presentation. Connectors describe settings and presentation
as data for ticketd to render.

Contract 2 is the first published contract. Contract 1 was internal, so the
initial transition can be a clean break. On startup the extension selects a
contract version that ticketd supports. Adding an optional field or capability
keeps the version. Other contract changes require a new version.

A source connection names a configuration for an account and site. Several
connections may use the same provider. Connections stay on each device and
are excluded from Workspace sync, backups, and exports. External ticket
identity is the provider plus an opaque, stable ID that is unique across all
accounts and sites of that provider. The same issue found by two connections
has one identity.

Adding a local extension requires consent after ticketd shows the exact command
it will run, the extension's ID and version, and its declared hosts. ticketd
hashes the entire installed folder and blocks execution after any change until
the person adds the extension again. Linked development folders skip the hash
check. Extensions run with the person's OS permissions, without a sandbox.
Declared hosts inform consent. The extension receives an allowlist of
environment variables plus those declared in its manifest, with all
`TICKETD_*` variables removed.

Saved secret values live in the operating system keychain, keyed by connection.
Connection settings keep references to keychain entries. ticketd supplies the
values only in protocol requests that need them. Extensions must keep them out
of persistent storage and logs. Password commands and environment overrides can
also supply values to ticketd. When Linux lacks a usable Secret Service, the
value stays in memory for the session and ticketd tells the person.

## Consequences

- [ADR 0006](0006-external-ticket-authority.md) continues to govern ticket
  authority as written. Synchronization is inbound, open issues keep local
  progress, and publication transfers authority only after confirmation.
  Taking ownership preserves external identity. Only a positive signal from
  the tracker can confirm closure.
- Cached tickets stay readable on devices without a matching connection.
  Each device selects at most one connection to refresh an issue. Rediscovery
  can resume refresh for a ticket whose tracker still owns it.
- The same conformance suite checks built-in and out-of-process adapters at the
  connector interface. It runs read-only by default, with explicit opt-in for a
  publish check. Linear is the first bundled extension to exercise the public
  contract.
- This decision covers local installation. The scope excludes a marketplace,
  remote registries or installations, extension update channels and signing,
  sandboxing and capability enforcement, extension-rendered UI, and OAuth or
  other multi-step sign-in.
