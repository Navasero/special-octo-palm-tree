/**
 * A diarized ambient-capture transcript for one routine outpatient encounter:
 * a hypertension follow-up with new symptoms, at the illustrative design
 * partner's rural clinic (assumption #2).
 *
 * Deliberately code-switched English/Filipino, most utterances mixing both
 * mid-sentence — the ordinary case in the target market, not an edge case
 * (assumption #5). An extractor that only handled English would miss almost
 * everything the patient says here, which is the point of testing against it.
 *
 * Audio offsets are synthetic but internally consistent, so span→audio
 * seeking can be asserted in tests.
 */

import type { Transcript } from '../src/ai/transcript.ts';

export const ENCOUNTER_TRANSCRIPT: Transcript = {
  id: 'txn-2026-0302-001',
  encounterRef: 'Encounter/enc-0001',
  audioUri: 'file:///edge/audio/txn-2026-0302-001.opus',
  utterances: [
    {
      id: 'u1',
      speaker: 'clinician',
      startMs: 0,
      endMs: 3500,
      text: 'Magandang umaga po. Kumusta ang pakiramdam ninyo ngayon?',
      languages: ['fil'],
    },
    {
      id: 'u2',
      speaker: 'patient',
      startMs: 3600,
      endMs: 11200,
      text: 'Doc, matagal na po itong ubo ko, mga two weeks na. Tapos masakit ang ulo ko halos gabi-gabi.',
      languages: ['fil', 'en'],
    },
    {
      id: 'u3',
      speaker: 'clinician',
      startMs: 11400,
      endMs: 14000,
      text: 'May lagnat po ba kayo?',
      languages: ['fil'],
    },
    {
      id: 'u4',
      speaker: 'patient',
      startMs: 14200,
      endMs: 20500,
      text: "Hindi naman po. And I've been feeling dizzy pag biglang tumatayo ako.",
      languages: ['fil', 'en'],
    },
    {
      id: 'u5',
      speaker: 'clinician',
      startMs: 20700,
      endMs: 27000,
      text: 'Let me check your blood pressure po. One-fifty over ninety-five. Mataas pa rin.',
      languages: ['en', 'fil'],
    },
    {
      id: 'u6',
      speaker: 'clinician',
      startMs: 27200,
      endMs: 32000,
      text: 'Are you still taking the amlodipine, five milligrams, araw-araw?',
      languages: ['en', 'fil'],
    },
    {
      id: 'u7',
      speaker: 'patient',
      startMs: 32200,
      endMs: 37500,
      text: 'Opo doc, pero minsan po nakakalimutan ko kapag busy.',
      languages: ['fil'],
    },
    {
      id: 'u8',
      speaker: 'clinician',
      startMs: 37700,
      endMs: 41000,
      text: 'May allergy po ba kayo sa gamot?',
      languages: ['fil', 'en'],
    },
    {
      id: 'u9',
      speaker: 'patient',
      startMs: 41200,
      endMs: 47000,
      text: 'Yung penicillin po. Nangangati ako at nagkaka-rashes.',
      languages: ['fil', 'en'],
    },
    {
      id: 'u10',
      speaker: 'clinician',
      startMs: 47200,
      endMs: 56000,
      text: 'Okay. Continue the amlodipine, and add losartan fifty milligrams once daily.',
      languages: ['en', 'fil'],
    },
    {
      id: 'u11',
      speaker: 'clinician',
      startMs: 56200,
      endMs: 62000,
      text: 'So for your hypertension, balik po kayo after two weeks para ma-recheck natin.',
      languages: ['en', 'fil'],
    },
  ],
};
