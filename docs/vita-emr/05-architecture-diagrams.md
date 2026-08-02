# C4 Architecture Diagrams

Rendered in Mermaid. These reflect the ADRs in `adr/` — in particular the
event-sourced core (ADR-0002), CRDT edge sync (ADR-0003/0009), the
provenance ledger (ADR-0004), tiered AI routing (ADR-0005), CDS Hooks
delivery (ADR-0006), the terminology service (ADR-0007), and schema-per-
tenant multi-tenancy (ADR-0008).

## Level 1 — System Context

```mermaid
C4Context
    title VITA — System Context

    Person(clinician, "Clinician", "Physician, nurse, midwife — ambulatory, inpatient, or outreach")
    Person(patient, "Patient", "Portal / mobile app user")
    Person(admin, "Governance / Ops Admin", "Clinical AI Governance Committee, IT/ops")

    System(vita, "VITA EMR", "FHIR-native, offline-first, AI-assisted EMR")

    System_Ext(lis, "Regional LIS", "Lab results via HL7v2 ORU / bidirectional interface")
    System_Ext(imaging, "Imaging Center / PACS", "DICOMweb, DICOM Q/R")
    System_Ext(payer, "Payers", "PhilHealth (illustrative) + private HMOs — eligibility, claims, remittance")
    System_Ext(hie, "National HIE", "Illustrative national health information exchange adapter")
    System_Ext(pharmacy, "Pharmacy / Supply Chain", "Stock and cold-chain systems")
    System_Ext(models, "AI Model Providers", "Edge / mid-tier / frontier, per ADR-0005 routing")

    Rel(clinician, vita, "Charts, orders, reviews AI drafts")
    Rel(patient, vita, "Views results, messages, refills")
    Rel(admin, vita, "Governance review, incident response, feature disable")
    Rel(vita, lis, "Orders out / results in (HL7v2, FHIR)")
    Rel(vita, imaging, "Orders out / images + reports in")
    Rel(vita, payer, "Eligibility, claims, remittance")
    Rel(vita, hie, "Document/summary exchange (XDS/XCA or FHIR, per Section 8)")
    Rel(vita, pharmacy, "Stock levels, cold-chain events")
    Rel(vita, models, "Inference requests, tiered per ADR-0005, residency-constrained")
```

## Level 2 — Containers

```mermaid
C4Container
    title VITA — Containers

    Person(clinician, "Clinician")
    Person(patient, "Patient")

    System_Boundary(vita, "VITA EMR") {
        Container(pwa, "Clinical PWA / Mobile", "Offline-capable PWA + native shell", "Tablet/phone client; local-first store per ADR-0003")
        Container(portal, "Patient Portal / App", "PWA", "Results, messaging, scheduling, refills")

        Container(edge, "Edge Appliance", "On-prem, low-power node", "Runs the same core stack locally for disconnectable facilities, per ADR-0009")

        Container(gateway, "API Gateway", "FHIR REST + GraphQL + Bulk FHIR + CDS Hooks + SMART on FHIR", "Everything the UI does, the API does (Section 8)")

        Container(eventcore, "Event-Sourced Clinical Core", "Append-only event log + FHIR-resource projections", "System of record, per ADR-0001/0002")
        Container(sync, "CRDT Sync Engine", "Clinically-tiered conflict resolution", "Per ADR-0003")
        Container(provenance, "Provenance Ledger", "Typed extension of the event log", "Per ADR-0004")
        Container(terminology, "Terminology Service", "SNOMED/LOINC/RxNorm-equiv/ICD/local codes", "Per ADR-0007")

        Container(router, "AI Model Router", "Edge / mid / frontier tiers", "Per ADR-0005")
        Container(ambient, "Ambient Documentation Service", "Layer 1", "Diarized transcription -> structured FHIR draft")
        Container(retrieval, "Chart Intelligence Service", "Layer 2", "Hybrid semantic+lexical retrieval, cited answers only")
        Container(cds, "CDS Hooks Services", "Layer 3, shadow-mode at launch per ADR-0010", "Interaction/dose/deterioration/guideline rules")
        Container(agents, "Agentic Ops Services", "Layer 4", "Prior auth, coding, denials, inbox triage — human approval gate on money/patient actions")

        ContainerDb(control, "Multi-Tenant Control Plane", "Tenant provisioning, per-tenant keys", "Per ADR-0008")
    }

    System_Ext(external, "External Systems", "LIS, imaging, payers, HIE, pharmacy")

    Rel(clinician, pwa, "Uses")
    Rel(patient, portal, "Uses")
    Rel(pwa, edge, "Syncs when local edge appliance present")
    Rel(pwa, gateway, "FHIR/GraphQL, when connected")
    Rel(portal, gateway, "FHIR/GraphQL")
    Rel(edge, gateway, "Reconciles on reconnect via CRDT sync")

    Rel(gateway, eventcore, "Reads/writes FHIR resources")
    Rel(gateway, cds, "CDS Hooks invocations")
    Rel(gateway, external, "HL7v2 / FHIR / DICOMweb / X12-equivalent")

    Rel(eventcore, sync, "Offline-authored events reconciled through")
    Rel(eventcore, provenance, "Every AI-authored event tagged into")
    Rel(eventcore, terminology, "Validates codes against")
    Rel(eventcore, control, "Partitioned per tenant")

    Rel(ambient, router, "Requests inference")
    Rel(retrieval, router, "Requests inference")
    Rel(cds, router, "Requests inference")
    Rel(agents, router, "Requests inference")

    Rel(ambient, eventcore, "Writes draft FHIR resources (Condition, Observation, MedicationRequest...)")
    Rel(retrieval, eventcore, "Reads for cited chart answers")
    Rel(cds, eventcore, "Reads for rule evaluation")
    Rel(agents, eventcore, "Reads/writes with human-approval gate")
```

## Level 3 — Component view: Ambient Documentation Service (Layer 1)

Chosen as the component-level detail example because it's the doctrine #1
capability ("the record writes itself") and the one with the tightest
latency budget (20s note-draft-ready, Section 10).

```mermaid
C4Component
    title VITA — Ambient Documentation Service (Layer 1) components

    Container_Boundary(ambient, "Ambient Documentation Service") {
        Component(capture, "Capture Client", "In-room mic / phone / headset", "Streams audio; buffers locally if offline")
        Component(diarize, "Diarization + Transcription", "Edge or mid-tier ASR", "Multi-speaker, medical vocabulary, code-switching support (assumption #5)")
        Component(extract, "Structured Extraction", "Mid-tier model", "Transcript spans -> FHIR resource drafts (Condition, Observation, MedicationRequest, Procedure, AllergyIntolerance)")
        Component(linker, "Span Linker", "Deterministic mapping layer", "Every generated sentence <-> source transcript span (doctrine #4 hard requirement)")
        Component(notegen, "Note Generator", "Mid/frontier tier per complexity", "Specialty-specific formats: SOAP, H&P, discharge summary, op note")
        Component(provwriter, "Provenance Writer", "-", "Emits ADR-0004-compliant ledger events for every draft")
    }

    Container(router, "AI Model Router")
    Container(eventcore, "Event-Sourced Clinical Core")
    Container(provenance, "Provenance Ledger")
    Person(clinician, "Clinician")

    Rel(capture, diarize, "Raw/buffered audio")
    Rel(diarize, extract, "Diarized transcript")
    Rel(extract, linker, "Draft resources + transcript span refs")
    Rel(extract, notegen, "Structured extraction feeds note draft")
    Rel(linker, notegen, "Span references embedded in draft note")
    Rel(diarize, router, "ASR inference request")
    Rel(extract, router, "Extraction inference request")
    Rel(notegen, router, "Note-generation inference request")
    Rel(notegen, provwriter, "Draft ready -> provenance event")
    Rel(provwriter, provenance, "Writes model id/version, prompt hash, confidence")
    Rel(notegen, eventcore, "Writes draft DocumentReference + structured resources (unsigned)")
    Rel(clinician, eventcore, "Reviews, edits, signs (or one-click rejects) via clinical PWA")
```
