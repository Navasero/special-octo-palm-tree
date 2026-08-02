# ADR-0009: Kubernetes core + disconnectable edge appliance

**Status:** Proposed

## Context

Section 7 requires Kubernetes deployment in both single- and multi-tenant
modes, an air-gapped installation path, and "an edge appliance for
facilities with poor connectivity." Assumption #7 takes worst-case
connectivity as intermittent 3G with multi-hour daily outages and
unreliable grid power. A 2,000-bed tertiary center and a 3-bed rural unit
must both be servable by the same platform (Section 1's mission
statement), not two different products.

## Decision

The control-plane/regional core runs on Kubernetes (cloud or on-prem),
serving connected facilities directly. Facilities below a connectivity
threshold run a **local edge appliance** — a small, low-power server
on-site running the same event-sourced core (ADR-0002) and offline sync
engine (ADR-0003) at facility scale, with the edge-tier AI models
(ADR-0005) local to it. The edge appliance is not a stripped-down separate
product: it's the identical software stack, deployed at a scale (single
facility, modest hardware, tolerant of grid interruption) that the
Kubernetes core is also capable of running at, just without the
multi-facility control-plane role. This is what lets Section 1's "2,000-bed
tertiary center and 3-bed rural unit, same platform" claim be an
architectural fact rather than a marketing claim.

## Alternatives considered

1. **Cloud-only deployment, with connectivity assumed reliable enough
   that "offline" just means a short client-side cache.** Rejected: fails
   assumption #7's connectivity reality outright and fails doctrine #3
   directly — this is the athenaOne/cloud-SaaS pattern from Section 3's
   benchmark, explicitly a documented gap for exactly this deployment
   profile.
2. **A materially different, lighter-weight product for low-connectivity
   sites** (à la a separate "lite" edition). Rejected: this recreates the
   two-codebases problem in a different form — feature drift between the
   "real" product and the "lite" product is exactly the kind of scope
   doctrine #8's "retrofitting is a rewrite" warning is about, applied to
   deployment topology instead of tenancy.
3. **Satellite/mesh connectivity investment to eliminate the offline
   problem at the infrastructure layer instead of the software layer.**
   Rejected as the primary strategy: it's a real mitigation worth pursuing
   opportunistically, but it doesn't reduce the software requirement (a
   satellite link can still go down, and grid power is the deeper
   constraint in assumption #7) — offline-first has to hold regardless of
   how good connectivity gets.

## Consequences

- The edge appliance's hardware baseline (grid-power-tolerant, low
  bandwidth) becomes a concrete target the whole platform is validated
  against, not just the frontend (Section 7's tablet-in-a-glove
  requirement extends to the backend the tablet talks to locally).
- Air-gapped installation (Section 7) is the edge-appliance deployment
  path with sync permanently disabled rather than a third deployment mode
  to build and maintain separately.
- Reconciliation on reconnect is the same CRDT sync mechanism (ADR-0003)
  whether the disconnected node was a single tablet or an entire edge
  appliance serving a whole facility — this uniformity is what keeps the
  "same platform" claim true operationally, not just architecturally.
- Operational cost: edge appliances need remote-manageable update/patch
  tooling that itself tolerates intermittent connectivity (can't assume a
  reliable channel to push security patches) — this is a real Phase 0/1
  engineering item, not incidental ops work.
