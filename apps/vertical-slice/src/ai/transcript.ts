/**
 * Diarized ambient-capture transcript (Layer 1 input).
 *
 * The span type here exists to satisfy the hard requirement in Section 5:
 * every generated sentence links back to the transcript span that produced
 * it, and one tap shows the source audio. That is only possible if spans
 * carry audio offsets, so `TranscriptSpan` does — a note sentence that can't
 * produce one is a bug, not a degraded experience (see note.ts).
 */

export type Utterance = {
  id: string;
  speaker: 'clinician' | 'patient' | 'other';
  startMs: number;
  endMs: number;
  text: string;
  /** BCP-47 tags present in this utterance. More than one = code-switched,
   *  which is the common case in the target market (assumption #5). */
  languages: string[];
};

export type Transcript = {
  id: string;
  encounterRef: string;
  audioUri: string;
  utterances: Utterance[];
};

/** A pointer back into the transcript, resolvable to a playable audio range. */
export type TranscriptSpan = {
  utteranceId: string;
  startChar: number;
  endChar: number;
  audioStartMs: number;
  audioEndMs: number;
  text: string;
};

export function utteranceById(transcript: Transcript, id: string): Utterance {
  const utterance = transcript.utterances.find((u) => u.id === id);
  if (!utterance) throw new Error(`no utterance ${id} in transcript ${transcript.id}`);
  return utterance;
}

/**
 * Build a span for a substring of an utterance, interpolating audio offsets
 * proportionally to character position.
 *
 * Proportional interpolation is an approximation — real ASR emits per-word
 * timings and those should be used instead when available. It is good enough
 * to seek playback to the right phrase, which is what the requirement needs.
 */
export function spanOf(
  transcript: Transcript,
  utteranceId: string,
  match: string,
): TranscriptSpan {
  const utterance = utteranceById(transcript, utteranceId);
  const startChar = utterance.text.toLowerCase().indexOf(match.toLowerCase());
  if (startChar < 0) {
    throw new Error(`"${match}" not found in utterance ${utteranceId}`);
  }
  const endChar = startChar + match.length;
  const duration = utterance.endMs - utterance.startMs;
  const length = Math.max(utterance.text.length, 1);
  return {
    utteranceId,
    startChar,
    endChar,
    audioStartMs: Math.round(utterance.startMs + (startChar / length) * duration),
    audioEndMs: Math.round(utterance.startMs + (endChar / length) * duration),
    text: utterance.text.slice(startChar, endChar),
  };
}

/** Distinct languages across the encounter — drives ASR model selection. */
export function languagesIn(transcript: Transcript): string[] {
  return [...new Set(transcript.utterances.flatMap((u) => u.languages))].sort();
}

/** True when any single utterance mixes languages (intra-sentential switching). */
export function hasCodeSwitching(transcript: Transcript): boolean {
  return transcript.utterances.some((u) => u.languages.length > 1);
}

export function plainText(transcript: Transcript): string {
  return transcript.utterances.map((u) => `${u.speaker}: ${u.text}`).join('\n');
}
