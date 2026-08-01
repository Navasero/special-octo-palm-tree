# ADR-0006: CDS Hooks as the delivery mechanism for all Layer 3 decision support

**Status:** Proposed

## Context

Section 5's Layer 3 explicitly requires shipping "as CDS Hooks services so
the logic is portable and independently auditable," and names alert
fatigue as "the primary enemy." Section 10 caps interruptive alerts at ≤5
per clinician per shift. Section 6 requires override-rate monitoring with
auto-suppression of any rule overridden more than 90% of the time.

## Decision

All Layer 3 clinical decision support (drug interaction/allergy/dose
checking, differential suggestions, guideline recommendations,
deterioration prediction) is implemented as standalone **CDS Hooks
services** consuming FHIR resources over the standard hook contract, not
as logic embedded directly in the clinical UI or application backend. The
alert budget and override-rate monitor (ADR-0004's ledger provides the
override-rate data) sit in front of the CDS Hooks response as a policy
layer: a hook response that would exceed a clinician's remaining alert
budget for the shift, or that comes from a rule whose rolling override
rate exceeds 90%, is suppressed before it reaches the UI and logged for
governance review rather than shown.

## Alternatives considered

1. **Rules embedded directly in application/UI code**, the pattern most
   incumbent systems' proprietary alert engines follow. Rejected: this is
   exactly what makes incumbent CDS logic hard to audit externally (per
   Section 3's benchmark) and impossible to reason about independently of
   the vendor's codebase — CDS Hooks' whole value is that the logic is a
   separately inspectable, standards-based service.
2. **No alert budget or override-rate governance — ship every rule
   unconditionally and rely on clinicians to manage alert fatigue
   themselves.** Rejected outright: this is the documented failure mode in
   Section 3's benchmark (override rates >90% for some interruptive
   alerts industry-wide) that Section 5 names as the primary enemy to
   design against.
3. **Third-party CDS Hooks content (e.g., an external clinical-content
   vendor) used unmodified, with no local override-rate monitoring.**
   Rejected as the default: the governance requirement (auto-suppress
   overridden rules, flag for review) has to apply uniformly whether the
   rule is authored in-house or sourced externally — a third-party rule
   with a 95% local override rate is still an alert-fatigue problem for
   this specific population and must be suppressible the same way.

## Consequences

- Every Layer 3 rule ships with a machine-readable guideline citation and
  version (Section 5's explicit requirement) as part of its CDS Hooks
  response payload, not as separate documentation that can drift from the
  deployed logic.
- The alert-budget/override-rate policy layer is a shared piece of
  infrastructure all CDS Hooks services pass through — individual rule
  authors (including future third-party content) don't need to
  reimplement budget-awareness themselves.
- This is a direct dependency of ADR-0010 (regulatory scope): because CDS
  Hooks services are independently identifiable and independently
  disable-able, the Clinical AI Governance Committee (Section 6) can turn
  off a single misbehaving rule in production without a full deployment,
  supporting the "<15 minute rollback" target in Section 6.
- Differential-diagnosis suggestions are explicitly clinician-invoked only
  (Section 5), which the CDS Hooks integration must implement as a
  distinct hook trigger from the always-on interaction-checking hooks —
  conflating the two would violate the "never unsolicited" requirement.
