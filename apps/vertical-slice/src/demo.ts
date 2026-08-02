/**
 * End-to-end vertical slice: one patient, one encounter, ambient note →
 * structured FHIR → signed → billed.
 *
 * This file only narrates. The clinical flow itself lives in scenario.ts and
 * is the same code the tests and the API server's seed data run.
 *
 * Run: npm run demo
 */

import { EventLog, deterministicClock } from './core/eventLog.ts';
import { chartFor, pendingReview, projectAsOf } from './core/projection.ts';
import { ledger, modelStats, toFhirProvenance } from './core/provenance.ts';
import { extractFindings } from './ai/extract.ts';
import { renderNoteWithCitations } from './ai/note.ts';
import { ModelRouter } from './ai/router.ts';
import { hasCodeSwitching, languagesIn } from './ai/transcript.ts';
import { ClinicalWorkspace } from './clinical/workspace.ts';
import { patientEverything, tenantExportManifest } from './api/export.ts';
import {
  DEMO_CLINICIAN,
  DEMO_ROUTING,
  runEncounterScenario,
} from './scenario.ts';

const line = (char = '─') => console.log(char.repeat(78));
function heading(step: string, title: string): void {
  console.log('');
  line();
  console.log(`${step}  ${title}`);
  line();
}

const s = runEncounterScenario();
const { log, patient, encounter, transcript, router } = s;

// ─── 1. Registration and encounter ──────────────────────────────────────────
heading('1.', 'Patient registration and encounter');
console.log(
  `Registered ${patient.name[0].given.join(' ')} ${patient.name[0].family} (${patient.id})`,
);
console.log(`Opened ${encounter.id} (${encounter.class.code})`);

// ─── 2. Ambient capture ─────────────────────────────────────────────────────
heading('2.', 'Ambient capture → structured extraction (Layer 1)');
console.log(`Transcript ${transcript.id}: ${transcript.utterances.length} utterances`);
console.log(`Languages: ${languagesIn(transcript).join(', ')}`);
console.log(`Intra-sentential code-switching: ${hasCodeSwitching(transcript) ? 'yes' : 'no'}`);
console.log(`\nRouting: ${s.extraction.decision.rationale}`);
for (const skip of s.extraction.decision.skipped) {
  console.log(`  skipped ${skip.tier}: ${skip.reason}`);
}
console.log(`\nExtracted ${s.extraction.findings.length} findings:`);
for (const finding of s.extraction.findings) {
  const cite = finding.spans.map((sp) => `${sp.utteranceId}@${sp.audioStartMs}ms`).join(', ');
  console.log(
    `  [${finding.kind.padEnd(10)}] ${finding.display.padEnd(22)} ` +
      `conf=${finding.confidence.toFixed(2)}  ← ${cite}`,
  );
}

// ─── 3. Drafts ──────────────────────────────────────────────────────────────
heading('3.', 'Drafts filed as FHIR resources');
for (const draft of s.drafts) {
  console.log(`  ${draft.resourceType.padEnd(20)} ${draft.resourceId.padEnd(30)} ${draft.eventId}`);
}

// ─── 4. Note ────────────────────────────────────────────────────────────────
heading('4.', 'Note generation, every sentence cited');
console.log(renderNoteWithCitations(s.note.draft!));
console.log(`\nFiled ${s.filedNote.document.id} as docStatus=preliminary`);

// ─── 5. Signing guard ───────────────────────────────────────────────────────
heading('5.', 'Signing is refused while drafts are unreviewed');
console.log(`Refused, correctly: ${s.refusedSignature.slice(0, 170)}…`);

// ─── 6. Review ──────────────────────────────────────────────────────────────
heading('6.', 'Clinician reviews each draft (accept / edit / reject)');
for (const review of s.reviews) {
  const suffix = review.note ? `  — ${review.note}` : '';
  console.log(`  ${review.action.toUpperCase().padEnd(7)} ${review.resourceId}${suffix}`);
}

// ─── 7. Revise and sign ─────────────────────────────────────────────────────
heading('7.', 'Note revised to match the review, then signed');
console.log(`Dropped from the note after review: ${s.rejectedConceptKeys.join(', ') || '(nothing)'}`);
console.log(
  `docStatus=${s.signed.docStatus}, attested by ${s.signed.attester![0].party.display}`,
);
console.log(`Encounter ${s.closedEncounter.id} → ${s.closedEncounter.status}\n`);
console.log(Buffer.from(s.signed.content[0].attachment.data, 'base64').toString('utf8'));

// ─── 8. Billing ─────────────────────────────────────────────────────────────
heading('8.', 'Coding → draft claim → human approval');
console.log('Suggested diagnoses (from accepted findings only):');
for (const diagnosis of s.coding.suggestion!.diagnoses) {
  const code = diagnosis.code.coding[0];
  console.log(`  ${code.code.padEnd(8)} ${code.display?.padEnd(34)} ${diagnosis.rationale}`);
}
console.log(`\nRejected and therefore not billed: ${s.rejectedConceptKeys.join(', ') || '(none)'}`);
console.log(
  `Claim ${s.claim.id}: status=draft → ${s.approvedClaim.status} after human approval, ` +
    `${s.claim.diagnosis.length} diagnoses, ${s.claim.total!.value} ${s.claim.total!.currency}`,
);

// ─── 9. Chart ───────────────────────────────────────────────────────────────
heading('9.', 'Resulting chart');
const chart = chartFor(log, patient.id, { actorId: DEMO_CLINICIAN.id, purpose: 'treatment' });
for (const entry of chart.entries) {
  const resource = entry.resource;
  const status =
    'docStatus' in resource
      ? resource.docStatus
      : 'status' in resource
        ? resource.status
        : 'verificationStatus' in resource
          ? resource.verificationStatus.coding[0].code
          : '—';
  console.log(`  ${resource.resourceType.padEnd(20)} ${resource.id.padEnd(28)} ${status}`);
}
console.log(`\nStill awaiting review: ${pendingReview(log, patient.id).length}`);

// ─── 10. Provenance ─────────────────────────────────────────────────────────
heading('10.', 'Provenance ledger (ADR-0004)');
for (const entry of ledger(log)) {
  const disposition = entry.review
    ? `${entry.review.action.toUpperCase()} by ${entry.review.by}`
    : 'PENDING';
  console.log(
    `  ${entry.resourceType.padEnd(20)} ${entry.provenance.modelId}@${entry.provenance.modelVersion} ` +
      `conf=${entry.provenance.confidence.toFixed(2)}  ${disposition}`,
  );
}
console.log('\nPer-model statistics (feeds override-rate monitoring):');
for (const stats of modelStats(log)) {
  console.log(
    `  ${stats.modelId} [${stats.tier}] drafts=${stats.drafts} ` +
      `accept=${stats.accepted} edit=${stats.edited} reject=${stats.rejected} ` +
      `overrideRate=${stats.overrideRate?.toFixed(2) ?? 'n/a'} cost=$${stats.totalCostUsd}`,
  );
}
console.log('\nFHIR Provenance projection for the signed note (truncated):');
console.log(
  JSON.stringify(toFhirProvenance(log, 'note-0001'), null, 2).split('\n').slice(0, 14).join('\n') +
    '\n  …',
);

// ─── 11. Audit, integrity, cost ─────────────────────────────────────────────
heading('11.', 'Audit, integrity, cost');
console.log(`Events appended: ${log.all().length}`);
console.log(`PHI reads logged: ${log.reads().length}`);
for (const read of log.reads()) {
  console.log(`  ${read.at}  ${read.actorId} read ${read.patientId} for ${read.purpose}`);
}
const integrity = log.verifyChain();
console.log(`\nHash chain: ${integrity ? `BROKEN at ${integrity.brokenAt.id}` : 'intact'}`);

const asOfRegistration = projectAsOf(log, 0);
console.log(`Time travel — chart as of event 0: ${asOfRegistration.size} resource(s)`);

const cost = router.costSummary();
console.log(`\nInference cost for this encounter: $${cost.totalCostUsd} across ${cost.calls} calls`);
for (const [task, amount] of Object.entries(cost.byTask)) {
  console.log(`  ${task.padEnd(18)} $${amount}`);
}

// ─── 12. The acid test ──────────────────────────────────────────────────────
heading('12.', 'Acid test: take your data and go (Section 8)');

const everything = patientEverything(log, patient.id, {
  actorId: DEMO_CLINICIAN.id,
  purpose: 'data-export',
});
console.log(
  `GET Patient/${patient.id}/$everything → ${everything.type} bundle, ` +
    `${everything.total} entries, ${JSON.stringify(everything).length} bytes of open-format FHIR`,
);
const types = [...new Set(everything.entry.map((e) => e.resource.resourceType))];
console.log(`  contains: ${types.join(', ')}`);

const manifest = tenantExportManifest(log, { actorId: 'ops-0001', purpose: 'tenant-export' });
console.log(`\nGET $export → ${manifest.output.length} NDJSON files, no vendor involvement:`);
for (const file of manifest.output) {
  console.log(`  ${file.type.padEnd(20)} ${String(file.count).padStart(3)} resources`);
}

console.log('');
line('═');
console.log('Slice complete: ambient note → structured FHIR → signed → billed → exportable.');
line('═');

// ─── 13. AI disabled ────────────────────────────────────────────────────────
heading('13.', 'The same workflow with AI fully disabled');
const offlineLog = new EventLog('tenant-district-hospital-01', deterministicClock());
const offlineWorkspace = new ClinicalWorkspace(offlineLog);
const noAi = ModelRouter.disabled();

offlineWorkspace.registerPatient(
  {
    id: 'pat-0002',
    identifier: [{ system: 'http://vita-emr.org/mpi', value: 'MPI-000002' }],
    name: [{ family: 'Santos', given: ['Jose'] }],
    gender: 'male',
    birthDate: '1975-02-02',
  },
  DEMO_CLINICIAN,
);
offlineWorkspace.openEncounter(
  { id: 'enc-0002', patientId: 'pat-0002', class: 'AMB', start: '2026-03-02T10:00:00.000Z' },
  DEMO_CLINICIAN,
);
const noAiExtraction = extractFindings(noAi, transcript, DEMO_ROUTING);
console.log(`Routing: ${noAiExtraction.decision.rationale}`);
console.log(`Findings: ${noAiExtraction.findings.length} (clinician charts manually)`);
console.log(
  `Chart still opens: ${
    chartFor(offlineLog, 'pat-0002', { actorId: DEMO_CLINICIAN.id, purpose: 'treatment' }).entries
      .length
  } resources, no AI involved`,
);
console.log(`Inference cost: $${noAi.costSummary().totalCostUsd}`);
