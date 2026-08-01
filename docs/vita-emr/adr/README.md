# Architecture Decision Records

The ten highest-leverage decisions for VITA, in the order a build team would
actually need to lock them down (data model and durability first, since
everything else — sync, AI provenance, multi-tenancy — is a projection or
consumer of the event log).

| ADR | Decision |
|---|---|
| [0001](0001-fhir-native-data-model.md) | FHIR R4 as the native internal data model, not an export format |
| [0002](0002-event-sourced-clinical-core.md) | Event-sourced clinical data layer; the chart is a projection |
| [0003](0003-offline-first-crdt-sync.md) | Offline-first sync via CRDTs with clinically-aware conflict resolution |
| [0004](0004-provenance-ledger.md) | Immutable, queryable provenance ledger for every AI-touched record |
| [0005](0005-ai-model-routing.md) | Tiered AI model routing (edge / mid / frontier) with a human-approval gate |
| [0006](0006-cds-hooks-delivery.md) | CDS Hooks as the delivery mechanism for all Layer 3 decision support |
| [0007](0007-terminology-service.md) | In-house terminology service as a first-class, versioned component |
| [0008](0008-multi-tenancy.md) | Schema-per-tenant multi-tenancy with a shared control plane |
| [0009](0009-deployment-topology.md) | Kubernetes core + disconnectable edge appliance, not cloud-only |
| [0010](0010-regulatory-scope-boundary.md) | Administrative/documentation scope at launch; CDS ships shadow-mode only |

Each ADR follows: Context → Decision → Alternatives considered → Rejection
rationale → Consequences. Status on all ten is **proposed** — none are final
until reviewed against real answers to the Section 15 clarification gate.
