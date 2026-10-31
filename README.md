# ticketd

A local ticket workspace with a desktop UI for people and a CLI for agents, sharing the same work and context.

## Product documentation

- [MVP specification](docs/mvp-spec.md): scope, behavior, and technical direction.
- [Domain glossary](GLOSSARY.md): canonical terminology.
- [High-level architecture](docs/architecture.md): runtime, module responsibilities, and data flows.

## Development workflow

Track features, bugs, implementation plans, and progress in [GitHub Issues](https://github.com/vantoan19/ticketd/issues). Repository documentation contains durable product and engineering guidance.

The Matt Pocock engineering skills are configured through `docs/agents/`. The skill package itself is installed in the developer's agent environment rather than vendored into this repository.

Read the [quality guidelines](docs/agents/quality.md) before implementing changes. Run `./scripts/check` with Node.js 22.14.0 or later; the first run downloads the pinned Markdown checker. Rust and frontend checks activate when their application manifests exist.
