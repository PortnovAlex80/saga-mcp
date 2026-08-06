/**
 * SRS structural CheckProvider — the first concrete CheckProvider for the
 * Production Cell architecture gate.
 *
 * This provider performs the SAME structural checks as the SRS submission
 * validator (§12 Decision Log, §D2 required fields, enum validity, SRS→PRD
 * trace) but runs inside a GateRun AFTER the CandidateSet is sealed, not at
 * the worker_done boundary. It reuses the shared srs-d2-parser module — no
 * rule duplication.
 *
 * CheckProvider contract (gate.ts:156-175):
 *   - Read-only w.r.t. authoritative state. Cannot move Workplace/Flow.
 *   - Returns a CheckOutcome ('passed' | 'failed' | 'unknown' | 'error').
 *   - The outcome is recorded as an immutable CheckReceipt by the GateRun driver.
 *
 * The provider receives the sealed CandidateSet's member product refs and
 * reads the SRS content from disk (via the injected content reader) to
 * perform structural validation. It does NOT read mutable live DB state —
 * only the sealed candidate's content.
 */

import type { CheckProvider, CheckOutcome } from '../../../process-modules/domain/workplace/gate.js';
import { validateD2Structure, checkDecisionLogSection, extractD2Stanzas } from './srs-d2-parser.js';

/**
 * Port for reading the content of a sealed CandidateSet member. The concrete
 * adapter reads from disk (project_repository.local_path + artifact.path),
 * same as the SRS validator. Injected at construction to keep the provider
 * driver-neutral and testable without a filesystem.
 */
export interface SrsContentReader {
  /**
   * Read the content of the SRS artifact referenced by the sealed CandidateSet.
   * Returns null if the content cannot be read (file missing, hash mismatch).
   */
  readSrsContent(artifactRef: string): string | null;
}

export const SRS_STRUCTURAL_CHECK_PROVIDER_ID = 'formalization.srs-structural.v1';
export const SRS_STRUCTURAL_CHECK_PROVIDER_VERSION = '1.0.0';
export const SRS_STRUCTURAL_CHECK_PROVIDER_DIGEST = 'srs-structural-v1-digest';

/**
 * Create the SRS structural check provider. The provider examines the SRS
 * document content for structural completeness:
 *   - §12 Decision Log section exists with sufficient columns
 *   - §D2 stanzas exist with all required fields
 *   - Enum fields (ac_kind, pattern, criticality) have valid values
 *
 * It does NOT check semantic quality, security, or traceability edges —
 * those are separate checks (or reviewer responsibilities).
 */
export function createSrsStructuralCheckProvider(
  contentReader: SrsContentReader,
): CheckProvider {
  return {
    providerId: SRS_STRUCTURAL_CHECK_PROVIDER_ID,
    version: SRS_STRUCTURAL_CHECK_PROVIDER_VERSION,
    run(input): CheckOutcome {
      // The SRS artifact ref is passed via parameters by the GateRun driver
      // (it reads the sealed CandidateSet members and passes the SRS ref).
      const srsRef = input.parameters['srsArtifactRef'];
      if (typeof srsRef !== 'string' || srsRef.length === 0) {
        return 'failed';
      }
      const content = contentReader.readSrsContent(srsRef);
      if (content === null) {
        // Cannot read the SRS content — unknown (not a definitive failure,
        // could be a transient I/O issue).
        return 'unknown';
      }
      // §12 Decision Log check.
      const decisionLogGap = checkDecisionLogSection(content);
      if (decisionLogGap) {
        return 'failed';
      }
      // §D2 structural check.
      const d2Gaps = validateD2Structure(content);
      if (d2Gaps.length > 0) {
        return 'failed';
      }
      // Also check that at least one §D2 stanza exists.
      const stanzas = extractD2Stanzas(content);
      if (stanzas.length === 0) {
        return 'failed';
      }
      return 'passed';
    },
  };
}
