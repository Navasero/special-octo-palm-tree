/**
 * Layer 4 coding assistance and charge capture.
 *
 * Two gates are enforced here rather than left to process discipline:
 *
 *  1. A claim can only be built from a *signed* note. Billing for content no
 *     clinician attested to is how automated coding turns into fraud.
 *  2. The claim is created as `draft` and stays there until a human approves
 *     it. Nothing in this module submits anything — "human approval gate for
 *     anything that touches money" is a code path, not a policy document.
 */

import type { AiProvenance } from '../core/events.ts';
import type { EventLog } from '../core/eventLog.ts';
import { buildProvenance } from '../ai/extract.ts';
import type { Extraction } from '../ai/extract.ts';
import type { ModelRouter, RoutingContext, RoutingDecision } from '../ai/router.ts';
import type { TranscriptSpan } from '../ai/transcript.ts';
import type { CodeableConcept, Claim, DocumentReference } from '../fhir/types.ts';
import type { Clinician } from '../clinical/workspace.ts';

export type SuggestedDiagnosis = {
  code: CodeableConcept;
  /** Shown to the coder alongside the suggestion — never a bare code. */
  rationale: string;
  spans: TranscriptSpan[];
};

export type CodingSuggestion = {
  diagnoses: SuggestedDiagnosis[];
  promptHash: string;
  latencyMs: number;
};

export type CodingResult = {
  suggestion: CodingSuggestion | null;
  decision: RoutingDecision;
  provenance: AiProvenance | null;
};

/** Illustrative charge master. A real one is payer- and contract-specific. */
export const FEE_SCHEDULE = {
  outpatientConsultation: {
    code: {
      coding: [
        {
          system: 'http://vita-emr.org/fhir/CodeSystem/local-procedure',
          code: 'CONSULT-OPD',
          display: 'Outpatient consultation',
        },
      ],
      text: 'Outpatient consultation',
    } satisfies CodeableConcept,
    amount: 500,
  },
} as const;

/** Multi-currency from the start (doctrine #8), not a later retrofit. */
export const DEFAULT_CURRENCY = 'PHP';

export function suggestCoding(
  router: ModelRouter,
  extraction: Extraction,
  ctx: RoutingContext,
): CodingResult {
  const decision = router.select('coding', ctx);
  const provider = decision.provider;
  if (!provider?.suggestCoding) {
    // No model: a human coder does this unaided, as they do today.
    return { suggestion: null, decision, provenance: null };
  }

  const suggestion = provider.suggestCoding({
    findings: extraction.findings,
    promptHash: extraction.provenance?.promptHash ?? '',
    latencyMs: 0,
  });
  router.record('coding', provider, suggestion.latencyMs);

  return {
    suggestion,
    decision,
    provenance: buildProvenance(
      provider,
      suggestion.promptHash,
      suggestion.latencyMs,
      extraction.provenance?.inputRefs ?? [],
      suggestion.diagnoses.length > 0 ? 0.9 : 0.5,
    ),
  };
}

export function isSigned(note: DocumentReference): boolean {
  return note.docStatus === 'final' && (note.attester?.length ?? 0) > 0;
}

export function buildDraftClaim(args: {
  claimId: string;
  patientId: string;
  note: DocumentReference;
  provider: Clinician;
  diagnoses: SuggestedDiagnosis[];
  created: string;
  currency?: string;
}): Claim {
  if (!isSigned(args.note)) {
    throw new Error(
      `refusing to build a claim from an unsigned note (${args.note.id}, docStatus=${args.note.docStatus})`,
    );
  }
  if (args.diagnoses.length === 0) {
    throw new Error('refusing to build a claim with no diagnosis');
  }

  const currency = args.currency ?? DEFAULT_CURRENCY;
  const consultation = FEE_SCHEDULE.outpatientConsultation;

  return {
    resourceType: 'Claim',
    id: args.claimId,
    // Draft until a human approves it. See approveClaim.
    status: 'draft',
    type: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' },
      ],
    },
    use: 'claim',
    patient: { reference: `Patient/${args.patientId}` },
    created: args.created,
    provider: { reference: `Practitioner/${args.provider.id}`, display: args.provider.display },
    priority: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }],
    },
    diagnosis: args.diagnoses.map((diagnosis, index) => ({
      sequence: index + 1,
      diagnosisCodeableConcept: diagnosis.code,
    })),
    item: [
      {
        sequence: 1,
        productOrService: consultation.code,
        net: { value: consultation.amount, currency },
      },
    ],
    total: { value: consultation.amount, currency },
  };
}

/**
 * The approval gate. A human — never an agent — moves a claim out of draft,
 * and the approval is itself an event, so who authorised the money is on the
 * record.
 */
export function approveClaim(
  log: EventLog,
  claim: Claim,
  by: Clinician,
  draftEventId: string,
): Claim {
  if (claim.status !== 'draft') {
    throw new Error(`claim ${claim.id} is already ${claim.status}`);
  }
  const approved: Claim = { ...claim, status: 'active' };
  log.append({
    tenantId: log.tenantId,
    actor: { kind: 'human', id: by.id, display: by.display, role: by.role },
    op: 'update',
    resourceType: 'Claim',
    resourceId: approved.id,
    resource: approved,
    // Links the approval to the AI-suggested draft, so the ledger records who
    // signed off on the money rather than leaving the claim forever "pending".
    reviewOf: { draftEventId, action: 'accept' },
  });
  return approved;
}

export function fileDraftClaim(
  log: EventLog,
  claim: Claim,
  provenance: AiProvenance | null,
): string {
  const event = log.append({
    tenantId: log.tenantId,
    actor: provenance
      ? {
          kind: 'ai',
          id: provenance.modelId,
          display: `${provenance.modelId}@${provenance.modelVersion}`,
          provenance,
        }
      : { kind: 'human', id: 'system', display: 'Charge capture', role: 'system' },
    op: 'create',
    resourceType: 'Claim',
    resourceId: claim.id,
    resource: claim,
  });
  return event.id;
}
