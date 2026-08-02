# Section 9 — Threat Model and Security Architecture (Outline)

> Status: **outline for this milestone**, not a completed threat model.
> The compliance-control mapping in Section 4 below is explicitly
> illustrative and must not be treated as legal or regulatory conclusion —
> per the build prompt's own instruction, engage local counsel before
> relying on it.

## 1. Scope and assumed top threats

Per Section 9's explicit direction, this model assumes **insider threat**
and **stolen/lost device** are the top two realistic vectors — more
likely, in a multi-facility deployment spanning a tertiary center and
rural outreach units, than a sophisticated external attacker. This shapes
priority: device-level protections and audit-of-reads get weight equal to
network/perimeter security, which is a different emphasis than a typical
enterprise-SaaS threat model.

Assets in scope: PHI at rest (event log + projections, per ADR-0002),
PHI in transit (client <-> edge appliance <-> core, per ADR-0009), AI
provenance ledger contents (ADR-0004), per-tenant encryption key material
(ADR-0008), and offline-cached PHI on clinician/patient devices.

## 2. STRIDE pass

| Threat category | Representative scenario | Primary mitigation |
|---|---|---|
| **Spoofing** | A device or user impersonates a legitimate clinician to read/write PHI, especially on a shared ward tablet | Per-session authentication bound to a specific clinician identity (not device-level trust alone); short session lifetimes on shared devices; biometric/PIN re-auth for sensitive actions |
| **Tampering** | An insider or compromised device modifies a chart entry or an AI provenance record after the fact | Event-sourced core (ADR-0002) makes the event log append-only; tampering requires rewriting history, which is detectable via cryptographic chaining/hash-linking of the event log, not just access-control trust |
| **Repudiation** | A clinician or AI agent denies having taken an action (e.g., an agentic-ops submission, Layer 4) | Provenance ledger (ADR-0004) attributes every write to an actor with timestamp; agentic actions additionally require the human-approval-gate event before anything touching money/patient is finalized, giving two attributable actors, not one |
| **Information disclosure** | A stolen tablet exposes cached offline PHI (assumption #7's offline reality means real PHI volume sits on client devices for days) | Encryption at rest on-device; remote-wipe capability; offline cache scoped to only the patients/encounters the clinician actually needs (not a full facility dump to every device); break-the-glass access is itself logged (see below) |
| **Denial of service** | A facility's edge appliance or connectivity is disrupted (assumption #7's baseline case, not just an attack) | Offline-first design (ADR-0003/0009) means normal operation *is* the DoS-tolerant path; this is a resilience property inherited from the architecture, not a bolt-on countermeasure |
| **Elevation of privilege** | An account with narrow clinical access (e.g., a rural-clinic nurse account) is used to reach tertiary-center-wide data, or a break-glass grant isn't scoped/expired correctly | Schema-per-tenant isolation (ADR-0008) bounds the blast radius structurally; break-the-glass grants are time-boxed and automatically reviewed post-hoc (below), not standing elevated access |

## 3. Key controls

- **Encryption**: at rest and in transit, per-tenant key management
  (ADR-0008), with support for customer-managed keys for tenants that
  require it.
- **Break-the-glass emergency access**: available with mandatory
  justification captured at time of access; every break-glass event
  triggers an automatic post-hoc review by the governance/compliance
  function (not merely logged and left unreviewed).
- **Granular consent management**, including sensitive-category
  segmentation (mental health, HIV, reproductive health, minor/pediatric
  records), with segmentation rules configurable per jurisdiction — this
  is a real requirement independent of which illustrative market is
  eventually confirmed, since sensitive-category handling rules differ by
  jurisdiction.
- **Immutable, tamper-evident audit log of every read and write of PHI** —
  reads matter as much as writes per Section 9's explicit statement; the
  event-sourced core (ADR-0002) needs a read-audit path added
  deliberately, since reads don't naturally produce events the way writes
  do — this is a concrete open engineering item, not solved by ADR-0002
  alone.
- **De-identification pipeline** for the research data mart (Section 4
  Tier 3), with a documented re-identification risk assessment required
  before any secondary use — not built yet in this milestone, flagged as a
  Phase 6-adjacent dependency.

## 4. Compliance target mapping (illustrative — counsel required)

| Control area | General target | Illustrative-market-specific mapping (Philippines, per assumption #1 — **not verified, needs local counsel**) |
|---|---|---|
| Data protection law | HIPAA-equivalent controls | Data Privacy Act of 2012 (RA 10173) and its IRR — consent, data-subject rights, breach notification |
| Regulator registration/breach duties | — | National Privacy Commission (NPC) registration as a personal-information controller/processor; NPC breach-notification timelines and process |
| Health-facility requirements | — | Department of Health (DOH) facility licensing requirements applicable to EMR use in a licensed facility |
| Claims/payer data specs | Payer integration standards | PhilHealth claims data specifications; national eKonsulta data specifications, where applicable |
| National reporting obligations | Public-health/quality reporting | Universal Health Care Act (RA 11223) reporting obligations |
| Security management system | ISO 27001 | Same target regardless of market — not jurisdiction-specific |
| Medical device software process | IEC 62304, where the software qualifies as a device | Only applicable if ADR-0010's scope boundary changes — at administrative/documentation scope, this does not currently apply |
| Service organization controls | SOC 2 Type II | Same target regardless of market |
| Quality management (device) | ISO 13485, where applicable | Same conditional as IEC 62304 above |

**This table is a starting checklist for counsel engagement, not a
completed compliance assessment.** Every row needs verification against
current law/regulation text and, where a device-classification question
exists, needs to be resolved jointly with ADR-0010's regulatory-scope
decision.

## 5. Open items before this becomes a real threat model

- A completed data-flow diagram per component in `05-architecture-diagrams.md`,
  with trust boundaries drawn explicitly (this outline states the
  boundaries conceptually but doesn't yet diagram them).
- A read-audit mechanism design for the event-sourced core (flagged above
  as a concrete gap, not just a principle).
- Formal engagement of local counsel for the compliance mapping in
  Section 4, before any of it is relied on operationally.
- A penetration-test/red-team plan, scoped once Phase 1's pilot
  environment exists — not meaningful to schedule against a docs-only
  milestone.
