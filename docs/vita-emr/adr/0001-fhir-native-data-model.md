# ADR-0001: FHIR R4 as the native internal data model

**Status:** Proposed

## Context

Every incumbent EMR in the benchmark (`../02-competitive-benchmark.md`) —
Epic, Oracle Health, MEDITECH — stores clinical data in a proprietary
internal schema and exposes FHIR as an API facade generated on top of it.
This is why their FHIR coverage, while broad, always trails their native
capability: every new field, extension, or workflow has to be built twice
(once in the proprietary model, once in its FHIR projection), and every
external integrator inherits the impedance mismatch between the two.
Doctrine #2 (Section 2 of the build prompt) requires the opposite: "every
internal object is a FHIR resource. There is no proprietary schema to
translate out of."

## Decision

FHIR R4 resources (Patient, Encounter, Condition, MedicationRequest,
Observation, etc. — see `../04-fhir-data-dictionary.md`) are the system of
record. Application code reads and writes FHIR resources directly; there is
no separate "domain model" that gets mapped to FHIR at the API boundary.
Local extensions use FHIR's own extension mechanism (with a registered
extension URL namespace) rather than side tables bolted onto a different
core schema.

## Alternatives considered

1. **Proprietary domain model + FHIR facade** (the incumbent pattern).
   Rejected: this is precisely the two-systems-of-record problem doctrine
   #2 exists to avoid, and it's the mechanism by which every incumbent's
   FHIR coverage perpetually lags its native capability.
2. **openEHR archetypes as the native model**, with FHIR as a projection.
   Rejected for this build: openEHR's dual-model (reference model +
   archetypes) is a legitimate and arguably more clinically expressive
   design, but it means the same two-systems-of-record cost doctrine #2 is
   trying to avoid, just with openEHR instead of a proprietary schema on
   the inside. It also has a materially smaller hiring pool and tooling
   ecosystem than FHIR in the target market. Revisit if a design partner
   has existing openEHR investment.
3. **Generic document store (arbitrary JSON) with FHIR-shaped conventions
   but no schema enforcement.** Rejected: gives up FHIR profile validation
   (a real correctness and interop guarantee) for flexibility the domain
   doesn't actually need — clinical data has a well-specified shape.

## Consequences

- Every internal service, migration, and integration speaks FHIR natively;
  the "acid test" export in Section 8 (dump a complete FHIR bundle for a
  patient or tenant, unassisted) is nearly free instead of a translation
  project.
- FHIR profile validation becomes the primary data-quality gate — invalid
  resources are rejected at write time, not discovered downstream.
- Anything FHIR R4 doesn't model well (e.g., some scheduling/resource-
  booking concerns) needs either a documented local extension or an
  explicit non-FHIR side-store with a clearly bounded scope — tracked
  case-by-case rather than becoming a shadow domain model by accretion.
- This decision is a hard dependency for ADR-0002 (event sourcing): the
  events being sourced are FHIR resource state transitions.
