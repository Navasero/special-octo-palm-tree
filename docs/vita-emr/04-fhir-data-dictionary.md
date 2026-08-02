# FHIR R4 Profile Set and Data Dictionary

> Scope note: this is the **core profile set for Phase 0/1** (Tier 1
> clinical core per Section 4), not the full US-Core-equivalent surface the
> build prompt eventually calls for. Extensions marked *(local)* are
> illustrative — placeholders for the national profile set a real
> deployment market requires (see `01-clarification-gate.md` #1), and must
> be replaced with a ratified national base profile if/when one exists.
> Per ADR-0001, these profiles constrain the actual system of record, not
> an export mapping — a resource that fails profile validation is rejected
> at write time.

## Conventions

- **Base**: the FHIR R4 base resource this profile constrains.
- **Must Support**: elements the system guarantees to populate/consume
  meaningfully (per US-Core-style Must Support semantics), not merely
  accept if present.
- **Local extension**: a VITA-namespaced extension (`http://vita-emr.org/
  fhir/StructureDefinition/<name>`, placeholder namespace) used where the
  base resource doesn't model something the target deployment needs.
- **Terminology binding**: the value set / code system bound, per
  ADR-0007's terminology service.

## Core resources

| Resource | Base | Must Support elements | Terminology binding | Local extensions |
|---|---|---|---|---|
| **Patient** | `Patient` | identifier (MPI id + national id type), name, gender, birthDate, address, telecom, communication (language + code-switching flag), generalPractitioner | `communication.language`: BCP-47 (`en`, `fil`, code-switch pairs per assumption #5) | `patient-biometric-identifier` *(local)* — probabilistic-match/biometric linkage token, per Section 4's MPI requirement |
| **Encounter** | `Encounter` | status, class (ambulatory/inpatient/ED/telehealth/home-visit/community-outreach — extends base `class` value set), subject, participant, period, location, reasonCode, hospitalization | `class`: extended local value set to cover community outreach and home visit, not just base FHIR encounter classes | `encounter-connectivity-state` *(local)* — connected/offline-authored/reconciled, needed to support ADR-0003's conflict-tier logic and downtime audit |
| **Condition** | `Condition` | clinicalStatus, verificationStatus, category (problem-list-item / encounter-diagnosis), code, subject, onsetDateTime, recordedDate, asserter | SNOMED CT (primary), ICD-10/11 (billing crosswalk via ADR-0007's terminology service) | — |
| **AllergyIntolerance** | `AllergyIntolerance` | clinicalStatus, verificationStatus, code, patient, reaction (manifestation, severity), recordedDate | SNOMED CT / RxNorm-equivalent for substance | `allergy-source-confidence` *(local)* — patient-reported vs. clinically-verified, needed since CDS allergy-checking (ADR-0006) must weight these differently |
| **MedicationRequest** | `MedicationRequest` | status, intent, medication (CodeableConcept, national formulary bound), subject, encounter, dosageInstruction, requester | National drug formulary (primary) with RxNorm-equivalent crosswalk | — |
| **MedicationAdministration** | `MedicationAdministration` | status, medication, subject, context, effective, performer, request (link back to MedicationRequest) | Same as MedicationRequest | `administration-sync-conflict-class` *(local)* — set by ADR-0003's sync engine when a concurrent-administration conflict is detected; drives mandatory human reconciliation, never auto-merged |
| **Observation** | `Observation` | status, category (vital-signs / laboratory / social-history), code, subject, encounter, effective, value[x], performer | LOINC (primary) | — |
| **Procedure** | `Procedure` | status, code, subject, encounter, performed[x], performer | SNOMED CT / local procedure code (CPT-equivalent) crosswalk | — |
| **Immunization** | `Immunization` | status, vaccineCode, patient, occurrence[x], lotNumber, site, doseQuantity | National immunization schedule code set | `immunization-cold-chain-event` *(local)* — links to the cold-chain tracking event (Section 4 Tier 2) for the specific lot administered |
| **DocumentReference** | `DocumentReference` | status, type, subject, content (attachment + format), context (encounter), author | LOINC document-type codes | `documentreference-generation-provenance` *(local)* — links to the ADR-0004 provenance-ledger event when the document (e.g., an ambient-generated note) was AI-drafted |
| **CarePlan** | `CarePlan` | status, intent, category, subject, period, activity, careTeam | SNOMED CT | — |
| **ServiceRequest** | `ServiceRequest` | status, intent, category (lab/imaging/referral/nursing), code, subject, encounter, requester, priority | LOINC (labs) / local imaging & referral code sets | — |
| **Provenance** | `Provenance` | target, recorded, agent (who/onBehalfOf), entity (what, per ADR-0004) | — | Generated as a projection of the internal provenance-ledger event (ADR-0004), not independently authored |

## Deferred to later milestones (not modeled yet)

Scheduling (`Schedule`/`Slot`/`Appointment` — Tier 1 scheduling in Section
4), billing/claims resources (`Claim`/`ExplanationOfBenefit` — Tier 2
revenue cycle), and population-health/quality-measure resources
(`Measure`/`MeasureReport` — Tier 3) are explicitly out of scope for this
docs-first milestone and belong to the vertical-slice and later
deliverables.

## Open items for the embedded clinician (assumption #10)

- Confirm `Encounter.class` local value set actually matches how the
  design-partner facility (assumption #2) names its own encounter types —
  this dictionary guesses at "community outreach" / "home visit" based on
  the build prompt's Tier 1 list, not confirmed workflow.
- Confirm which `Condition`/`AllergyIntolerance` fields are safe for
  CRDT auto-merge vs. require the human-reconciliation tier in ADR-0003 —
  this dictionary flags `AllergyIntolerance` and `MedicationAdministration`
  as sensitive but the full per-field conflict-tier table is clinical
  judgment, not yet produced.
