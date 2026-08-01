# VITA — Vital Intelligence for Total-care Automation

An AI-native, FHIR-first EMR architecture, designed against the Master Build
Prompt in this repository's originating task. This directory is the **docs-first
foundation** milestone: clarification-gate answers, competitive analysis,
architecture decisions, data model, diagrams, AI governance, and a threat
model. It intentionally contains **no running code yet** — see
[Scope of this milestone](#scope-of-this-milestone).

## Why this exists in this repository

This repository (`special-octo-palm-tree`) started as GitHub's stock
"Introduction to GitHub" skills-course template (see the root `README.md`
and `.github/steps/`). That tutorial content has been left untouched — it
isn't part of VITA and nothing here depends on it. Everything for VITA
lives under `docs/vita-emr/` so the two are cleanly separable if this ever
needs to move to its own repository.

## Reading order

1. [`01-clarification-gate.md`](01-clarification-gate.md) — Section 15 answers.
   **Read this first.** Most of the rest of this directory is built on
   explicitly labeled *illustrative assumptions*, not confirmed business or
   regulatory facts. Anyone using this as a real blueprint must replace those
   assumptions with real answers (and real counsel) before committing capital
   or code.
2. [`02-competitive-benchmark.md`](02-competitive-benchmark.md) — Epic /
   Oracle Health / MEDITECH / athenaOne / OpenMRS-Bahmni / Medplum / Canvas /
   Elation, compared on the dimensions the build prompt specifies.
3. [`adr/`](adr/) — the ten highest-leverage architecture decisions, each
   with alternatives considered and why they were rejected.
4. [`04-fhir-data-dictionary.md`](04-fhir-data-dictionary.md) — the core FHIR
   R4 profile set and data dictionary.
5. [`05-architecture-diagrams.md`](05-architecture-diagrams.md) — C4 context,
   container, and component diagrams (Mermaid).
6. [`06-ai-governance.md`](06-ai-governance.md) — risk classification, eval
   harness, shadow-mode policy, monitoring, provenance ledger, governance
   committee charter.
7. [`07-threat-model.md`](07-threat-model.md) — STRIDE threat model, trust
   boundaries, and a compliance-control map (explicitly flagged as
   illustrative where it touches jurisdiction-specific law).

## Scope of this milestone

The Master Build Prompt describes a multi-quarter build for a multi-team
org (twelve deliverables including a certified-quality threat model, a
runnable vertical slice, a TCO spreadsheet, and a clickable UX prototype).
This milestone deliberately covers the **docs-first foundation** slice of
that list — the artifacts a team needs before writing a line of product
code — and defers the following to later milestones, in this order:

- Working vertical slice (one patient → ambient note → FHIR → signed →
  billed) as runnable code
- OpenAPI + FHIR CapabilityStatement
- Clickable UX prototype of the three highest-volume workflows
- Test strategy document (unit / integration / clinical-scenario / chaos /
  AI eval harness)
- TCO spreadsheet with editable assumptions

## What "illustrative assumption" means here

Section 15 of the build prompt asks for real answers on deployment market,
regulatory ambition, funding runway, embedded-clinician staffing, and more —
decisions that belong to the business, not to a model. Per explicit
direction, this milestone proceeds with clearly labeled placeholder answers
(a Philippines pilot, administrative/documentation scope only, no device
clearance at launch) so downstream architecture work has something concrete
to reason about. Every document that depends on one of these assumptions
says so inline. Treat anything under this directory as a **draft for
review**, not a decided plan.
