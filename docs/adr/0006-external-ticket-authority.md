# External ticket authority with inbound synchronization

External trackers organize high-level work while ticketd provides a home for local decomposition and organization. Synchronize externally owned ticket content only into ticketd; publishing a local ticket is a one-time outward operation that transfers authority after the external identity is confirmed. This deliberately avoids ongoing outbound edit queues and two-way conflict reconciliation while preserving local notes, relationships, and ticket identity.

Local progress is an explicit exception to external status authority: while a GitHub issue remains open, ticketd manages Todo, In progress, and In review without outbound writes. Publication and repeated open-state refreshes preserve local progress; external closure determines terminal status, and reopening returns the ticket to Todo.

Authority is independent of provenance: explicitly taking ownership stops synchronization and removes the external ownership indicator, but retains the external identity. Discovery must respect that choice instead of recreating the ticket or restoring external ownership automatically. See the product specification, section 15.7, for the agreed behavior.
