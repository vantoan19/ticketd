# Domain documentation

This repository uses one domain context:

- `GLOSSARY.md`: canonical domain terms. Read before exploring domain behavior and use its vocabulary in code, issues, and documentation.
- `docs/product.md`: what ticketd does today. Read the relevant sections before proposing or changing functionality.
- `docs/architecture.md`: runtime and module responsibilities. Read before changing the core interface, persistence, or desktop/CLI integration.
- `docs/adr/`: durable architectural decisions. Read relevant ADRs before changing the affected area; surface conflicts explicitly.

Proceed if an ADR directory or document does not exist. Create ADRs lazily for consequential decisions with genuine trade-offs; do not add placeholder decisions or directories.

Keep definitions in the glossary and behavior in the product description. Organize implementation tasks and investigation notes locally in ticketd. Summarize decisions on the relevant public issue. Update domain definitions as terms are resolved.
