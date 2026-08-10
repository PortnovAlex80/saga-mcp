import type { CandidateSet } from '../../process-modules/domain/workplace/candidate-set.js';

/** Read-only CandidateSet authority used by module check providers. */
export interface CandidateSetReaderPort {
  read(candidateSetRef: string): CandidateSet | null;
}
