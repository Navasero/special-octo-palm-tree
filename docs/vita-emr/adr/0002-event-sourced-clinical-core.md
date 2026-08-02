# ADR-0002: Event-sourced clinical data layer; the chart is a projection

**Status:** Proposed

## Context

Section 7 requires free audit, free time-travel, and clean offline sync.
Section 9 requires an immutable, tamper-evident log of every read and write
of PHI. Section 6 requires a permanent, queryable provenance record for
every AI-touched record. All three requirements point at the same
underlying mechanism rather than three separate subsystems.

## Decision

Every state change to a FHIR resource is appended as an immutable event to
a per-tenant event log (resource type, resource id, operation, full
resource body or patch, actor, provenance metadata, timestamp, causally
consistent version). The "current chart" — everything the clinical UI and
API read — is a materialized projection rebuilt from that event log. Reads
never touch the event log directly; they hit projections optimized for
query (the ≤800ms chart-open budget in Section 10 depends on the
projection being read-optimized, not on scanning events at read time).

## Alternatives considered

1. **CRUD over a relational schema with a separate audit-log table.** This
   is the incumbent pattern. Rejected: the audit log and the live data can
   drift (an update that isn't also logged, a logging bug that doesn't
   affect the live write path), and there's no structural guarantee they
   stay consistent. Offline sync also becomes much harder to reason about
   without an event log as the sync primitive — see ADR-0003.
2. **Change-data-capture (CDC) off a CRUD database as the "event log."**
   Rejected: CDC captures storage-engine-level changes, not
   domain-meaningful clinical events with actor/provenance attached at the
   point of the write. Retrofitting provenance onto CDC output is fragile
   and doesn't give the AI provenance ledger (ADR-0004) a clean event to
   attach to.
3. **Full openEHR-style versioned-object persistence without a separate
   event-log/projection split.** Rejected mainly on the same "two systems
   of record" grounds as ADR-0001 — versioned objects give you history but
   not the same clean single-writer event stream that offline CRDT sync
   (ADR-0003) needs.

## Consequences

- The event log is the actual source of truth; the FHIR-resource
  projection (ADR-0001) is derived and can be rebuilt from scratch,
  which is also the disaster-recovery story (Section 11's RPO/RTO
  targets).
- Every event carries the fields the provenance ledger (ADR-0004) needs
  natively — this is not a bolt-on for AI-touched records, it's the same
  mechanism for every record, human- or AI-authored.
- Concurrent-write conflict resolution (a nurse and a physician editing
  the same medication order offline, then reconnecting) becomes "what does
  it mean to merge two divergent event streams," which is exactly the
  problem CRDTs are built for — see ADR-0003.
- Cost: projection-rebuild and event-log storage growth need real
  operational tooling (compaction/snapshotting strategy) from Phase 0, not
  as a later optimization — deferring this is how event-sourced systems
  become unmaintainable.
