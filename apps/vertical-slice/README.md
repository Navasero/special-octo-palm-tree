# VITA vertical slice

Deliverable #10 from the build prompt: **one patient, one encounter, ambient
note → structured FHIR → signed → billed**, as running code.

```bash
cd apps/vertical-slice
npm run demo     # walks the whole flow, prints the trace
npm test         # 41 tests
npm run typecheck  # requires: npm install
```

Requires **Node ≥ 22.6** and nothing else. No build step, no runtime
dependencies, no network — types are stripped natively by Node, tests run on
`node:test`. That is deliberate: an EMR that claims an air-gapped
installation path shouldn't have a demo that needs to reach a registry to
start.

## What it actually does

1. Registers a patient and opens an ambulatory encounter.
2. Takes a diarized, code-switched (English/Filipino) ambient transcript.
3. Extracts findings — conditions, an allergy with its reactions, two
   medications with dose and intent, a blood pressure dictated as
   *"One-fifty over ninety-five"* — each linked to the transcript span and
   audio offset it came from.
4. Files them as FHIR drafts: `Condition` as `provisional`,
   `MedicationRequest` as `draft`, `Observation` as `preliminary`.
5. Generates a SOAP note where **every sentence carries its citations**.
6. Refuses to sign the note while any draft is still unreviewed.
7. Takes the clinician's accept / edit / reject on each draft, then
   regenerates the note from what survived and signs it.
8. Suggests ICD-10 codes from the *accepted* findings only, builds a
   **draft** claim, and requires a human to activate it.
9. Prints the chart, the provenance ledger, override-rate statistics, the
   PHI read audit, hash-chain verification, and per-encounter inference cost.
10. Re-runs the whole thing with AI switched off, to show the record still
    works.

## The one thing to be clear about

**The "model" in this slice is not a language model.** `src/ai/providers/
deterministic.ts` is rule-based — a lexicon, a spoken-number parser, and
templated note assembly. It exists so the slice runs offline and
deterministically, which is what makes the safety properties testable at
all. Its accuracy on real encounters would be poor and it is not the ambient
AI described in Layer 1 of the architecture.

What it *does* demonstrate faithfully is the machinery around the model,
which is the part that carries the clinical risk: span-linked provenance,
per-draft confidence, the draft→review→sign contract, the billing gates, and
the routing that decides whether a model is allowed to see this data at all.

Plugging in a real model means implementing the `ModelProvider` interface in
`src/ai/router.ts` and registering it. Nothing else changes — no capability
depends on a specific model.

## How it maps to the architecture

| Decision | Where it lives |
|---|---|
| ADR-0001 FHIR-native model | `src/fhir/types.ts`, `src/clinical/materialize.ts` |
| ADR-0002 event-sourced core | `src/core/eventLog.ts`, `src/core/projection.ts` |
| ADR-0004 provenance ledger | `src/core/provenance.ts` |
| ADR-0005 tiered model routing | `src/ai/router.ts` |
| ADR-0007 terminology service | `src/ai/lexicon.ts` *(stubbed — see below)* |
| ADR-0008 tenant isolation | `EventLog` rejects cross-tenant writes |
| ADR-0010 documentation scope | Note drafts, never diagnoses; no CDS |

## Properties the tests actually pin down

The suite is weighted toward things whose failure would be a safety or
compliance problem rather than a bug:

- A **rejected** draft leaves the chart, stays in the log, and never reaches
  a claim.
- A claim **cannot** be built from an unsigned note, or with no diagnosis.
- A claim is created `draft`; only a human event activates it.
- Every extracted finding and every note sentence is **traceable to audio**.
- Tampering with a historical event **breaks the hash chain** and is
  detected.
- Identified PHI is **not routed** to a cross-border provider; an offline
  site is not routed to a provider needing connectivity.
- With AI disabled the encounter still completes, costs nothing, and leaves
  an **empty provenance ledger**.

## What this slice is not

- **Not persistent.** The event log is in-memory. A durable implementation
  satisfies the same interface; the projection/read-optimization split
  (ADR-0002) is stubbed as an on-demand replay.
- **Not a terminology service.** `lexicon.ts` is a static table with
  **illustrative codes**. Real bindings are resolved and version-pinned
  through the service in ADR-0007. Do not treat any code in it as validated.
- **Not offline sync.** CRDT reconciliation (ADR-0003) is designed but not
  implemented here; this slice covers a single node.
- **No CDS.** Per ADR-0010, Layer 3 is out of scope at this stage.
- **No API surface.** OpenAPI + FHIR CapabilityStatement are a separate
  deliverable.
- **Not validated against a FHIR profile validator.** Resources are shaped
  to R4 and to the profiles in the data dictionary, but profile validation
  (which ADR-0001 makes the primary data-quality gate) is not wired up.

## Sample output

```
Extracted 9 findings:
  [condition ] Headache               conf=0.88  ← u2@8309ms
  [condition ] Cough                  conf=0.88  ← u2@5665ms
  [condition ] Fever                  conf=0.79  ← u3@11873ms
  [allergy   ] Penicillin             conf=0.93  ← u9@41747ms, u9@43389ms, u9@46234ms
  [medication] Amlodipine             conf=0.92  ← u6@29075ms
  [vital     ] Blood pressure         conf=0.96  ← u5@23651ms

  REJECT  cond-pat-0001-fever  — patient denied fever; extracted from a question

Rejected and therefore not billed: fever
Claim claim-0001: status=draft, 4 diagnoses, total 500 PHP
After human approval: status=active

vita-stub-extractor [mid] drafts=11 accept=8 edit=2 reject=1 overrideRate=0.27
Hash chain: intact
```

The `fever` finding is a genuine extraction error left in on purpose: it is
picked up from the clinician's *question* ("May lagnat po ba kayo?"), which
the patient then denied. It shows the reject path doing real work, and it is
the kind of error a real ambient system makes constantly.
