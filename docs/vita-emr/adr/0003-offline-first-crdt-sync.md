# ADR-0003: Offline-first sync via CRDTs with clinically-aware conflict resolution

**Status:** Proposed

## Context

Assumption #7 in `../01-clarification-gate.md` takes the build prompt's
"14 days fully offline" requirement literally. A rural unit must chart
vitals, document encounters, and place orders with zero connectivity, then
reconcile on reconnect without silently losing or corrupting data. Some
conflicts are safe to auto-merge (two different vitals observations for
the same encounter); some are never safe to auto-merge (two concurrent
medication-administration records for the same dose).

## Decision

Client devices run a local-first store that accepts writes offline and
syncs via CRDTs (conflict-free replicated data types) once connectivity
returns. Conflict resolution is **tiered by clinical semantics**, not
handled generically:

- **Additive/commutative events** (new Observation, new note, new order)
  merge automatically — this is the easy CRDT case and covers most
  clinical documentation.
- **Concurrent-modification of the same resource** (two edits to the same
  Condition) auto-merges only for field-level, non-overlapping changes; any
  overlapping-field conflict is surfaced as a **structured reconciliation
  task** to a clinician, never auto-resolved silently.
- **Safety-critical concurrent writes** (medication administration,
  order discontinuation/verification) are explicitly *not* eligible for
  CRDT auto-merge at all — the sync protocol detects the conflict class up
  front and routes straight to human reconciliation, by design, before
  either write is considered "applied" to the canonical chart.

## Alternatives considered

1. **Last-write-wins (LWW) sync**, the simplest and most common offline
   pattern. Rejected outright: LWW silently discards one clinician's
   documented action in favor of whichever device's clock/sync happened
   second — unacceptable for medication administration, allergy entry, or
   any safety-critical write.
2. **Operational Transformation (OT)** instead of CRDTs. Rejected: OT
   requires a central server to sequence operations, which defeats
   offline-first (a rural unit with no connectivity for days has no server
   to transform against); CRDTs are designed to converge without a
   coordinator.
3. **No offline support; require connectivity, degrade to read-only cache
   when unavailable** (the incumbent pattern per Section 3's benchmark).
   Rejected: fails assumption #7 outright and fails Section 2 doctrine #3
   directly.

## Consequences

- The event-sourced core (ADR-0002) is a prerequisite: CRDT merge
  operates over the event stream, not over a mutable row, which is what
  makes "detect this conflict class before either write is canonical"
  possible.
- The clinical team (assumption #10's embedded clinician) must classify
  every resource type's conflict tier before Phase 1 ships offline
  support for it — this is clinical judgment, not an engineering default,
  and is one of the concrete reasons the embedded-clinician assumption is
  high-leverage.
- Sync engine correctness needs its own dedicated test suite (chaos-style
  partition/reconnect scenarios) called out explicitly in the test
  strategy deliverable — this is not adequately covered by ordinary
  integration tests.
- Device storage and battery budget for 14 days of offline operation is a
  hardware-compatibility constraint on the offline client, not just a
  software one; this shapes the frontend's target-device baseline
  (Section 7's "5-year-old Android tablet").
