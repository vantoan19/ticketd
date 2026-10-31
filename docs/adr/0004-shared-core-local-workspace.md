# Shared Rust core with direct local database access

The desktop and CLI use separate instances of one Rust core library to access a single SQLite workspace in the operating system's application-data directory, allowing the CLI to operate with the desktop closed without requiring a daemon. This simplifies runtime dependencies but requires validating cross-process writes, graph invariants, migrations, and UI refresh before finalizing the topology. The core exposes workflow operations and hides persistence coordination internally; multiple selectable workspaces and a generic storage framework are outside the MVP.

The direct-access topology is accepted for the MVP's bounded local workload: a
1,000-ticket workspace with short titles, a 50-node graph, and eight concurrent
CLI processes was exercised on an Apple M1 Pro. Cross-process dependency races,
request replay, rollback, and concurrent initial opens preserved their
invariants; migration coordination and recovery also have focused core tests.
This is an operating target for further measurement, not a capacity guarantee.
Larger workspaces, sustained contention, graph interaction, and desktop latency
on other machines remain to be measured. Revisit the topology if those workloads
show unacceptable contention or coordination failures; a daemon is not required
by the measured workload alone.
