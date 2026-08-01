/**
 * Layer 1 note generation.
 *
 * The note is a structure of sentences, each carrying its source spans —
 * not a blob of prose with citations bolted on afterwards. That ordering is
 * what makes "one tap shows the source audio" implementable: the link exists
 * before the text is rendered, so it cannot be lost in rendering.
 */

import type { AiProvenance } from '../core/events.ts';
import { buildProvenance, type Extraction } from './extract.ts';
import type { ModelRouter, RoutingContext, RoutingDecision } from './router.ts';
import type { Transcript, TranscriptSpan } from './transcript.ts';
import { promptHashFor } from './extract.ts';

export type SoapSection = 'Subjective' | 'Objective' | 'Assessment' | 'Plan';

export type NoteSentence = {
  section: SoapSection;
  text: string;
  /** Non-empty by construction — see assertEverySentenceCited. */
  spans: TranscriptSpan[];
};

export type NoteDraft = {
  format: 'SOAP';
  sentences: NoteSentence[];
  promptHash: string;
  latencyMs: number;
};

export type GeneratedNote = {
  draft: NoteDraft | null;
  decision: RoutingDecision;
  provenance: AiProvenance | null;
};

export const SECTION_ORDER: SoapSection[] = [
  'Subjective',
  'Objective',
  'Assessment',
  'Plan',
];

/**
 * The hard requirement, enforced. A sentence the model can't trace back to
 * something that was said doesn't go in the note.
 */
export function assertEverySentenceCited(draft: NoteDraft): void {
  const uncited = draft.sentences.filter((s) => s.spans.length === 0);
  if (uncited.length > 0) {
    throw new Error(
      `note draft has ${uncited.length} uncited sentence(s): ` +
        uncited.map((s) => `"${s.text}"`).join(' | '),
    );
  }
}

export function generateNote(
  router: ModelRouter,
  transcript: Transcript,
  extraction: Extraction,
  ctx: RoutingContext,
): GeneratedNote {
  const decision = router.select('note-generation', ctx);
  const provider = decision.provider;

  if (!provider?.generateNote) {
    return { draft: null, decision, provenance: null };
  }

  const draft = provider.generateNote(transcript, {
    findings: extraction.findings,
    promptHash: promptHashFor(transcript),
    latencyMs: 0,
  });
  assertEverySentenceCited(draft);
  router.record('note-generation', provider, draft.latencyMs);

  return {
    draft,
    decision,
    provenance: buildProvenance(
      provider,
      draft.promptHash,
      draft.latencyMs,
      [`Transcript/${transcript.id}`, transcript.encounterRef],
      // Note-level confidence is the weakest link across cited findings, not
      // the average: one shaky sentence makes the whole note need a closer read.
      extraction.findings.length
        ? Math.min(...extraction.findings.map((f) => f.confidence))
        : 0.5,
    ),
  };
}

export function renderNote(draft: NoteDraft): string {
  return SECTION_ORDER.map((section) => {
    const lines = draft.sentences.filter((s) => s.section === section);
    if (lines.length === 0) return null;
    return `${section}:\n${lines.map((l) => `  ${l.text}`).join('\n')}`;
  })
    .filter(Boolean)
    .join('\n\n');
}

/** Render with inline span markers, for the "show me your sources" view. */
export function renderNoteWithCitations(draft: NoteDraft): string {
  return SECTION_ORDER.map((section) => {
    const lines = draft.sentences.filter((s) => s.section === section);
    if (lines.length === 0) return null;
    const body = lines
      .map((line) => {
        const cites = line.spans
          .map((s) => `${s.utteranceId}@${s.audioStartMs}-${s.audioEndMs}ms`)
          .join(', ');
        return `  ${line.text}\n      ↳ ${cites}`;
      })
      .join('\n');
    return `${section}:\n${body}`;
  })
    .filter(Boolean)
    .join('\n\n');
}
