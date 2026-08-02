# ADR-0007: In-house terminology service as a first-class, versioned component

**Status:** Proposed

## Context

Section 8 requires SNOMED CT, LOINC, RxNorm (or a national drug
formulary), ICD-10/11, and CPT/local procedure codes, with mapping,
versioning, and value-set management as "a first-class component," not an
afterthought. Assumption #9 in `../01-clarification-gate.md` adopts
build-in-house for this specifically because it's the piece Section 3's
benchmark suggests every incumbent under-invests in relative to its
downstream impact (bad terminology mapping silently corrupts CDS,
analytics, and interop simultaneously).

## Decision

A dedicated terminology service owns: code system storage and versioning
(SNOMED CT, LOINC, ICD-10/11, CPT/local codes, and a national drug
formulary per assumption #1's illustrative market), value-set definition
and expansion, cross-map management (e.g., local formulary ↔ RxNorm-
equivalent), and a stable API every other service calls rather than
embedding its own copy of a code system. Version transitions (e.g., an
annual ICD-10 code-set update) are themselves modeled as versioned,
auditable events — consistent with ADR-0002 — so "which version of which
code set was in effect when this diagnosis was coded" is an answerable,
not reconstructed, question.

## Alternatives considered

1. **Buy a commercial terminology service** (several exist for the US/EU
   markets). Rejected as the default for the illustrative deployment
   market specifically: most commercial terminology services are weakest
   exactly where this build needs strength — national/local formulary and
   procedure-code mapping for a market outside the US/EU — so buying would
   still require significant in-house mapping work on top of a paid
   license.
2. **No dedicated service — embed code-system lookups directly in each
   consuming service** (the common shortcut). Rejected: this is the
   pattern that produces the drift Section 8 is explicit about avoiding —
   two services independently vendoring slightly different versions of
   the same code system is a documented source of silent CDS and claims
   errors industry-wide.
3. **Use a third-party terminology server (e.g., an open-source FHIR
   terminology server) unmodified, without local mapping/versioning
   ownership.** Partially adopted: an existing open-source terminology
   server is a reasonable implementation substrate (avoids building
   $Set/$expand/$validate-code operations from scratch), but the
   national/local mapping and versioning content on top of it is still an
   in-house-owned asset per assumption #9 — the decision is about owning
   the content and versioning policy, not necessarily the wire protocol
   implementation.

## Consequences

- CDS Hooks services (ADR-0006), CPOE, coding-assistance agents (Section
  5 Layer 4), and analytics/quality-measure computation (Section 4 Tier 3)
  all depend on this service rather than each maintaining their own code
  mappings — a single place to fix a mapping error.
- Annual/periodic code-system updates become a scheduled, tested
  operational process (with a defined rollback per ADR-0002's versioned-
  event pattern) rather than an ad hoc migration each service handles
  independently.
- This is a real, non-trivial build investment (assumption #9 flags it as
  "a real bet") — if the illustrative market's terminology mapping need
  turns out thinner than assumed, this is the ADR to revisit toward
  buy-and-integrate instead.
- Value-set definitions used by CDS rules (ADR-0006) must be pinned to a
  specific terminology-service version at rule-authoring time, so a
  code-system update doesn't silently change which patients a rule fires
  for.
