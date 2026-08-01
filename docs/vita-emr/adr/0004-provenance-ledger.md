# ADR-0004: Immutable, queryable provenance ledger for every AI-touched record

**Status:** Proposed

## Context

Doctrine #4 requires every AI output to be a draft with provenance,
confidence, and a one-click reject, with permanent auditable attribution.
Section 6 requires a provenance ledger recording model ID, version, prompt
hash, input references, confidence, reviewing clinician, timestamp, and
accept/edit/reject action, for every AI-touched record.

## Decision

The provenance ledger is not a separate system bolted onto AI features —
it is a **typed extension of the same event log** ADR-0002 already
establishes. Any event whose author is an AI component carries a
mandatory `provenance` block (model id + version, prompt hash, input
resource references, confidence score, latency, cost) in addition to the
standard actor/timestamp fields every event already has. The
clinician-facing accept/edit/reject action on an AI-drafted item is itself
a first-class event, linked to the original draft event by id — so "was
this AI output accepted, edited, or rejected, by whom, when" is answerable
by the same query mechanism as any other chart-history question, not a
bespoke audit subsystem.

## Alternatives considered

1. **Separate provenance/audit database, written alongside (not as part
   of) the main event log.** Rejected: reintroduces the exact
   two-systems-of-record drift risk ADR-0002 exists to eliminate — a bug
   in the "also write to the audit DB" path silently produces an
   incomplete provenance record with no structural guarantee of catching
   it.
2. **Provenance as metadata fields on the resource itself** (e.g., a
   `lastModifiedByAI` flag on the FHIR resource) rather than as
   ledger events. Rejected: this only captures the current state, not the
   full accept/edit/reject history, and doesn't satisfy the "permanent and
   auditable" requirement once a field is overwritten again.
3. **FHIR's built-in `Provenance` resource, used generically without a
   VITA-specific structured extension for AI metadata.** Partially
   adopted, not rejected outright: `Provenance` is the right FHIR-native
   shape for the external/interop-facing view of this data (Section 8
   requires standards-based export). The decision here is that the
   *internal* source of truth is the tagged event, and a `Provenance`
   resource is generated as a projection of it for FHIR API consumers —
   avoiding, again, a second authoritative copy.

## Consequences

- Every AI feature (Layer 1 through 5) must emit ledger-compliant events
  through the same write path as human-authored changes — there is no
  separate "fast path" for AI writes that bypasses provenance capture, by
  construction.
- The one-click reject UX (doctrine #4) maps directly to an event, which
  means reject rates are queryable in real time — this is also the data
  source for the CDS override-rate monitor in ADR-0006/Section 6's
  continuous-monitoring requirement.
- Storage cost: prompt hashes and input references are stored, not raw
  prompts/full model input by default (privacy and storage-cost reasons);
  a documented, access-controlled path to reconstruct full context must
  exist for governance-committee incident review, per Section 6.
- This ledger is the auditable record a regulator or the Clinical AI
  Governance Committee (Section 6) would inspect during an incident
  review — its schema needs sign-off from that committee, not just
  engineering, before Phase 2 (Ambient AI) ships user-facing.
