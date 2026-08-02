# Section 6 — AI Safety, Governance & Evaluation Specification

> This spec assumes ADR-0010 (administrative/documentation scope at
> launch, CDS shadow-mode only) holds. If Section 15 question 8 is
> answered differently by the actual business, the certification burden
> below expands significantly for Layer 3 before any user-facing release.

## 1. Risk classification per feature

| Layer | Feature | IMDRF SaMD-style classification | Basis |
|---|---|---|---|
| 1 | Ambient transcription (raw diarized text) | **Not decision support** — verbatim capture, no clinical assertion | Transcription of what was said carries no independent clinical claim |
| 1 | Structured extraction (transcript -> Condition/Observation/etc. draft) | **Administrative/documentation support**, draft-only, mandatory clinician sign-off | Drafts a clinician-reviewable candidate record; does not finalize or act on it (doctrine #4) |
| 1 | Specialty note generation | **Administrative/documentation support** | Same rationale — a signed note is a clinician's attestation, not the model's |
| 2 | Chart summary / pre-visit brief | **Administrative/documentation support**, cited | Presents existing clinical data; asserts nothing new. Uncited claims are a release blocker (Section 6 requirement carried into eval gate below) |
| 2 | Cross-encounter reasoning ("has this patient ever been on X") | **Administrative/documentation support**, cited | Same — retrieval and synthesis of existing record, not new diagnosis |
| 3 | Drug-drug/allergy/dose-range checking | **Decision support — regulated in most jurisdictions.** Shadow-mode only at launch per ADR-0010 | Directly informs a prescribing decision |
| 3 | Diagnostic differential suggestion | **Decision support — regulated in most jurisdictions.** Shadow-mode only, clinician-invoked when eventually released | Suggests possible diagnoses |
| 3 | Guideline-concordant care recommendation | **Decision support — regulated in most jurisdictions.** Shadow-mode only | Recommends a care pathway |
| 3 | Deterioration prediction (sepsis, decompensation) | **Decision support — regulated in most jurisdictions.** Shadow-mode only, requires local calibration evidence before any release decision | Directly triggers escalation-of-care actions |
| 4 | Prior-auth packet assembly, coding suggestion, denial-appeal drafting | **Administrative automation**, human approval gate before submission | Assembles/drafts; does not submit or finalize autonomously |
| 4 | Referral loop-closure chasing, inbox triage/routing | **Administrative automation** | No clinical assertion; operational routing only |
| 4 | Scheduling optimization, recall/outreach | **Administrative automation** | Operational, not clinical |
| 5 | Cohort discovery, care-gap detection, resource forecasting | **Administrative/population-analytics**, auditable compiled query | Not applied to an individual clinical decision at the point of care |

**Standing rule:** any feature whose output could plausibly be read as
asserting a diagnosis, changing a prescribing decision, or triggering a
clinical escalation without clinician review is treated as decision
support by default, not administrative — reclassification downward
requires governance-committee sign-off, not an engineering judgment call.

## 2. Evaluation harness (mandatory before merge, doctrine #10)

Every AI feature, regardless of risk classification, requires all of the
following before it merges:

- **Golden dataset**, clinician-adjudicated, sized appropriately to the
  feature's risk tier (decision-support features require materially larger
  and more diverse golden sets than administrative ones).
- **Metrics**: factual accuracy, omission rate, hallucination rate, and —
  the one that gates release — **clinically-significant-error rate**
  (an error that would plausibly change clinical management if acted on
  unreviewed), plus latency and cost against the routing budget (ADR-0005).
- **Adversarial suite**, run against every feature: contradictory chart
  data, missing/sparse data, rare disease presentation, pediatric,
  pregnancy, polypharmacy, non-English and code-switched input (per
  assumption #5), and poor-quality audio (for Layer 1).
- **Subgroup performance reporting** by age, sex, language, and facility
  type (tertiary vs. rural/edge-deployed). **A regression in any subgroup
  blocks release outright** — an aggregate-metric improvement does not
  offset a subgroup regression.

No feature ships without all four; a feature that hasn't been built
against a golden dataset yet is, by definition, not ready to enter shadow
mode either.

## 3. Shadow-mode requirement

Every clinical AI feature (anything classified decision support, and any
administrative feature the governance committee deems warrants it) runs
silently against real production data for a defined period before any
user-facing release:

- Outputs are generated and logged to the provenance ledger (ADR-0004) but
  never shown to the clinician.
- Shadow-mode outputs are reviewed against actual clinical outcomes/
  clinician documentation as an independent check on the golden-dataset
  eval.
- The shadow-mode period's length and exit criteria (accuracy floor,
  clinically-significant-error ceiling, subgroup parity) are set by the
  Clinical AI Governance Committee per feature, not fixed globally —
  a sepsis-deterioration model warrants a longer shadow period than an
  inbox-routing classifier.
- Per ADR-0010, Layer 3 features remain in shadow mode indefinitely at
  launch, pending a separate regulatory-pathway decision — shadow mode is
  not a fixed-duration gate for them but the default launch state.

## 4. Continuous monitoring

- **Drift detection**: golden-dataset and adversarial-suite metrics
  re-evaluated on a recurring schedule against live-traffic samples, not
  just at merge time.
- **Override-rate tracking**: every accept/edit/reject event (ADR-0004) is
  aggregated per rule/feature. Per Section 5's alert-fatigue mandate, any
  interruptive CDS rule with a rolling override rate above 90% is
  **auto-suppressed** and flagged for governance review — this is
  implemented at the CDS Hooks policy layer (ADR-0006), not as a manual
  process.
- **Incident reporting pipeline**: any clinically-significant error
  identified in production (via shadow-mode review, override-rate
  anomaly, or direct clinician report) is logged, triaged by the
  governance committee, and tracked to resolution.
- **Rollback**: every AI feature has a documented, tested rollback path
  with a **target of under 15 minutes** — for CDS Hooks services this is a
  single-service disable (ADR-0006); for Layer 1/2 it's a router-level
  fallback to "no AI assistance" (ADR-0005), never a full deployment
  rollback.

## 5. Provenance ledger

Specified in full at ADR-0004. Summary of what it guarantees for
governance purposes: for every AI-touched record — model ID and version,
prompt hash, input resource references, confidence score, reviewing
clinician, timestamp, and accept/edit/reject action — immutably and
queryably, as a typed extension of the same event log every other write
goes through (ADR-0002), not a bolt-on audit system.

## 6. Clinical AI Governance Committee — charter

- **Composition**: the embedded practicing clinician (assumption #10,
  chaired or co-chaired), a clinical informaticist, an engineering lead
  for the AI stack, a patient-safety/quality officer, and — once pursued —
  a regulatory-affairs representative. Committee composition should be
  ratified against the *real* team composition once assumption #10 is
  confirmed, not this placeholder list.
- **Review cadence**: standing review of shadow-mode evidence and
  override-rate flags on a recurring cadence (at minimum monthly during
  active phases 2–5 of the roadmap); ad hoc review triggered immediately
  by any clinically-significant-error incident.
- **Authority**: the committee has standing authority to disable any AI
  feature in production immediately, independent of engineering or
  business sign-off, and to block a shadow-mode feature's exit to
  user-facing release regardless of eval-harness metrics if clinical
  judgment says the evidence isn't sufficient.
- **Escalation**: any feature the committee cannot resolve internally
  (e.g., a genuine ambiguity on regulatory classification) escalates to
  the business decision-makers who own Section 15's clarification-gate
  answers — the committee does not infer regulatory conclusions itself,
  consistent with Section 9's "engage local counsel" instruction.
