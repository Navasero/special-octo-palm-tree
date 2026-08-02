# ADR-0008: Schema-per-tenant multi-tenancy with a shared control plane

**Status:** Proposed

## Context

Doctrine #8 requires multi-tenant, multi-language, multi-currency,
multi-regulator support "from commit #1," explicitly warning that
retrofitting is a rewrite. Section 9 requires per-tenant key management
with support for customer-managed keys, and Section 7 requires both
single-tenant and multi-tenant deployment modes, including an air-gapped
installation path.

## Decision

Each tenant (a hospital system, a standalone clinic) gets an isolated
schema/namespace within the event-sourced core (ADR-0002) — its own event
log partition, its own projection stores, its own encryption key material —
while a shared control plane handles cross-tenant concerns that are
genuinely shared infrastructure: the terminology service's code-system
content (ADR-0007, since SNOMED/ICD are not tenant-specific), platform
deployment/upgrade tooling, and the model-routing layer's shared
infrastructure (ADR-0005) where residency rules permit. A single-tenant
deployment (a customer requiring full physical isolation, or an air-gapped
site) is the same schema-per-tenant model with the tenant count fixed at
one — not a structurally different codebase or deployment path.

## Alternatives considered

1. **Fully shared schema with a `tenant_id` column on every table/event**
   (the cheapest multi-tenancy pattern to build). Rejected: makes
   per-tenant customer-managed-key encryption (Section 9) and full
   physical data isolation for air-gapped/on-prem deployments (Section 7)
   much harder to guarantee — a missed `WHERE tenant_id = ?` is a
   cross-tenant PHI leak, not a caught-at-compile-time error, in this
   pattern.
2. **Database-per-tenant with fully separate application deployments per
   tenant** (maximum isolation). Rejected as the default: this makes the
   "single codebase from 5 to 50,000 concurrent users" scaling requirement
   (Section 11) operationally expensive — every tenant becomes its own
   fleet to operate, upgrade, and monitor, which doesn't scale
   operationally to a large multi-tenant SaaS book of business even though
   it scales technically.
3. **Single-tenant-only architecture, with "multi-tenant" bolted on
   later as a hosting concern.** Rejected outright per doctrine #8's
   explicit warning that this is a rewrite, not a later feature.

## Consequences

- Per-tenant encryption keys (Section 9) map cleanly onto schema/namespace
  boundaries — a tenant's data is decryptable only with its own key
  material, and customer-managed keys are a per-schema configuration, not
  a system-wide one.
- The air-gapped/single-tenant deployment path (Section 7) is validated
  continuously as "the multi-tenant control plane running with tenant
  count = 1," rather than as a separately maintained deployment mode that
  can drift out of sync with the multi-tenant path.
- Shared control-plane components (terminology content, platform upgrade
  tooling) must be designed so they never need direct access to any
  tenant's PHI-bearing schema — this boundary needs to be enforced in the
  threat model (`../07-threat-model.md`), not just assumed.
- Operational cost: schema-per-tenant at 10,000+ tenants needs real
  investment in tenant-provisioning and cross-tenant operational tooling
  (migrations that run safely across many schemas) from Phase 0 — this is
  a known cost of the choice, not a later surprise.
