# Repository conventions

Keep durable product requirements, domain definitions, and architectural decisions in the repository. Use GitHub Issues only for bugs, enhancements, ideas, and improvements. Organize implementation breakdowns, investigations, and subtickets in your local ticketd workspace. Keep working notes out of the repository.

## Agent skills

### Engineering quality

Before implementing or reviewing code, read `docs/agents/quality.md`. Run `./scripts/check` before handing off changes; start with small, focused tests and expand only for meaningful risk.

### Interface

Before building or changing UI, read `docs/agents/ui.md`.

### Issue tracker

Before creating, reading, or updating work items, read `docs/agents/issue-tracker.md`. Use `gh` for this repository's public issues and the ticketd CLI for local tasks.

### Triage labels

Before triaging or assigning readiness labels, read `docs/agents/triage-labels.md` for the canonical vocabulary.

### Domain docs

Before exploring or changing domain behavior, read `docs/agents/domain.md`. This repository uses a single domain context.
