# ADR-0010: Administrative/documentation scope at launch; CDS ships shadow-mode only

**Status:** Proposed — highest-leverage assumption in this milestone; see
`../01-clarification-gate.md` item #8.

## Context

Section 6 requires a risk classification per AI feature against the IMDRF
SaMD framework, distinguishing "decision support" (regulated in most
jurisdictions) from "administrative automation" (generally not), and
explicitly notes that ambient scribing which only transcribes is different
from a note that asserts a diagnosis. No confirmed answer exists yet on
whether the business intends to pursue device clearance for CDS (Section
15, question 8) — this ADR adopts the conservative illustrative assumption
so the roadmap and governance spec have a concrete, buildable boundary.

## Decision

At launch, every shipped, user-facing AI feature is classified as
**administrative automation or non-assertive documentation support**, not
regulated decision support:

- **Layer 1 (ambient documentation)** ships as *transcription and
  structuring assistance* — it drafts, with full provenance and one-click
  reject (ADR-0004); it does not autonomously assert a diagnosis or
  finalize a note without clinician sign-off. This keeps it on the
  administrative side of the line Section 6 draws.
- **Layer 2 (retrieval/chart intelligence)** ships as cited, sourced
  retrieval — every answer traces to a source document (Section 5's
  explicit requirement) — which is presentation of existing clinical data,
  not new decision support.
- **Layer 3 (CDS)** — drug interaction/dose checking, differential
  suggestion, deterioration prediction — is **built and evaluated, but runs
  in shadow mode only** (per Section 6's shadow-mode requirement) until a
  deliberate, separately funded regulatory-pathway decision is made. It is
  not exposed as a user-facing interruptive feature at launch under this
  assumption.
- **Layer 4 (agentic operations)** ships with human-approval gates on
  anything touching money or a patient (Section 5's explicit requirement),
  which keeps it on the administrative-automation side even though it's
  clinically adjacent (e.g., coding suggestions are administrative;
  auto-submitting a claim without review would not be).

## Alternatives considered

1. **Pursue device clearance for CDS from Phase 0**, launching with Layer
   3 fully user-facing and regulator-cleared. Rejected as the launch
   default: this is a materially slower, more expensive path (a real
   regulatory workstream, not just an engineering one) that the funding-
   runway assumption (#11) doesn't currently budget for reaching before
   the first inpatient pilot. If the real answer to Section 15 question 8
   is "yes, pursue clearance from day one," this ADR is the one to revisit
   first — it changes Phase 5's position in the roadmap and adds a funded
   regulatory-affairs workstream starting Phase 0.
2. **Ship Layer 3 user-facing without pursuing clearance, on the theory
   that clinician-in-the-loop review makes it non-regulated by
   construction.** Rejected: this is a real regulatory risk, not a
   documentation nuance — "clinician can override the AI" does not
   reliably exempt decision-support software from device regulation in
   every jurisdiction, and getting this wrong is a compliance failure, not
   an engineering one. Erring conservative (shadow-mode only) until
   counsel confirms otherwise is the safer default explicitly called for
   in Section 9's "engage local counsel" instruction.
3. **Skip Layer 3 entirely at launch rather than building it in shadow
   mode.** Rejected: shadow-mode operation is exactly what Section 6
   requires as the evidence-gathering step before any future user-facing
   release decision — building and running it silently against real data
   now is what makes a later go/no-go decision (with real
   sensitivity/specificity/override-rate evidence) possible, rather than
   starting that evidence-gathering process only after a clearance
   decision is already made.

## Consequences

- The Section 6 governance spec's launch-time certification burden is
  bounded to administrative/documentation-scope features — this is what
  makes the Phase 1–4 roadmap achievable on the assumed funding runway
  (assumption #11).
- Shadow-mode Layer 3 still needs its full eval harness (golden dataset,
  adversarial suite, subgroup reporting — Section 6) built and run from
  Phase 2 onward, even though nothing user-facing ships from it yet — this
  is real, non-deferrable engineering work, not something this ADR allows
  skipping.
- If assumption #8 is confirmed wrong (the business does want CDS as a
  launch differentiator, or a design partner requires it), this ADR, the
  roadmap's Phase 5 placement, and the governance spec's launch
  certification scope all need to be revisited together — they're coupled
  decisions, not independent ones.
- This scope boundary must be stated plainly to any design partner and to
  local counsel before Phase 1 pilot begins, per Section 9's explicit
  instruction not to infer regulatory conclusions from a model's training
  data.
