# ADR-0005: Tiered AI model routing with a human-approval gate

**Status:** Proposed

## Context

Section 5 requires a router architecture (edge/on-device, mid-tier,
frontier) with per-task model class, context strategy, cost, and offline
fallback specified — and requires the EMR to remain fully functional with
all AI disabled. Assumption #6 (data residency) and assumption #9
(build/buy for speech recognition) both bear directly on where inference is
allowed to run.

## Decision

A routing layer sits in front of every AI capability and selects a model
tier per invocation based on: (a) task class, (b) connectivity state, (c)
data-residency constraint of the specific PHI involved, (d) latency
budget. Three tiers:

- **Edge/on-device or on-prem-appliance tier** — small models for
  latency-critical or fully-offline work (e.g., ambient transcription
  triage, basic drug-interaction lookups against a local terminology
  cache). Must function with zero connectivity, per doctrine #3.
- **Mid tier** — regional/in-country-hosted models for extraction,
  summarization, and most Layer 1/2/4 work — the default tier for
  identified-PHI workloads under assumption #6's residency placeholder.
- **Frontier tier** — used only for complex reasoning tasks that warrant
  it (per Section 5's explicit "only when warranted"), and only on
  de-identified or explicitly consented data unless a sovereign/on-prem
  frontier-class deployment is contracted for a given tenant.

Every capability's routing spec states, per Section 5's requirement: model
class, context strategy, expected cost per invocation, and the fallback
behavior when that tier is unavailable — the fallback for every tier is
"degrade to a lower tier or to no AI assistance," never "block the
clinical workflow."

## Alternatives considered

1. **Single frontier model for everything, routed to the cloud
   unconditionally.** Rejected: violates assumption #6 (residency) for any
   tenant where it applies, breaks doctrine #3 (offline-first) entirely,
   and is not cost-viable against the Section 12 per-encounter inference
   ceiling.
2. **Single small on-device model for everything, no frontier tier at
   all.** Rejected: fails the Layer 3/Layer 5 tasks that Section 5
   explicitly reserves for frontier-class reasoning (complex differential
   reasoning, cohort-discovery query compilation) — a single small model
   can't cover that quality bar.
3. **Per-tenant static model assignment** (each hospital configured to use
   exactly one tier for everything) instead of per-invocation dynamic
   routing. Rejected: collapses the offline/connectivity-aware fallback
   requirement into a manual ops task per site, instead of a property of
   the system that holds automatically when a rural unit loses
   connectivity mid-shift.

## Consequences

- Every new AI capability's design doc must fill in the four-column
  routing spec (task/model class/context strategy/cost/fallback) before
  it's eligible to ship — this is the mechanism that operationalizes
  Section 2 doctrine #10 ("every AI feature ships with its eval harness or
  it does not ship") at the routing-decision level too.
- "AI fully disabled" is a supported, tested configuration, not a
  theoretical one — every clinical workflow (order entry, documentation,
  results review) must have a manual path that doesn't depend on any AI
  tier being reachable.
- The frontier tier's real-money cost is the primary lever for the
  Section 12 per-encounter inference-cost ceiling — router policy
  (how aggressively tasks escalate to frontier) is a cost-engineering
  control surface, tracked in CI per doctrine #9, not just a quality knob.
- Sovereign/on-prem model deployment (assumption #6) is a per-tenant
  configuration of the mid/frontier tiers' endpoint, not a fork of the
  routing logic — this needs validating early since it's a real
  architectural constraint if residency turns out to be a hard
  requirement.
