/**
 * Formalization acceptance-contract submission validator.
 *
 * Shifts the AC traceability gate (every AC → exact FR/NFR + UC) from the
 * post-hoc resolver to the worker_done boundary. Before this validator, the
 * LM could call worker_done with an incomplete acceptance bundle (AC-10
 * linked only to RULE, missing the mandatory FR/NFR edge), and the gap was
 * discovered only by resolve-acceptance-contract — AFTER the expensive worker
 * execution had already ended. Now the worker is told the gaps BEFORE it
 * leaves, so it can fix and retry without burning a recovery epoch.
 *
 * The validation logic is the SAME `findContractGap({ acceptance: true })`
 * the resolver uses — extracted and reused, not duplicated. This guarantees
 * the pre-submit gate and the post-hoc resolver never disagree on what a
 * valid acceptance contract looks like.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';

/**
 * Driver-neutral database handle alias. See srs-contract-validator.ts for
 * rationale (Wave 7 architecture test: no-sqlite-in-modules).
 */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}
import {
  buildContractSnapshot,
  constraintCoverageGapIdList,
  findContractGap,
} from './formalization-contract-analysis.js';
import {
  constraintCoverageSubmissionGaps,
  readConstraintCoverageRequirement,
} from './constraint-coverage.js';
import { readExactArtifactContent } from './artifact-content-reader.js';
import { parseAtomicAcceptanceCriteria } from '../domain/acceptance-criterion-document.js';
import type { FormalizationArtifactSnapshot, FormalizationCanonicalGraphPort, FormalizationTraceSnapshot } from '../domain/formalization-kernel-ports.js';
import type {
  NodeSubmissionValidationInput,
  NodeSubmissionValidationResult,
  NodeSubmissionValidator,
  SubmissionGap,
  SubmissionValidationReceipt,
} from '../../../process-modules/application/node-submission-policy.js';

export const ACCEPTANCE_CONTRACT_VALIDATOR_ID = 'formalization.acceptance-contract.v1';
// 1.1.0 — AC-drift remedy: the coverage ratchet. The DECLARED version (what
// the gate matches against) and the version STAMPED INTO SEALED RECEIPTS
// must be this one constant — a dual literal here once produced member keys
// the check could never find (receipts stamped 1.0.0 vs checks demanding
// 1.1.0 → SUBMISSION_VALIDATION_RECEIPT_REQUIRED loop).
// 1.2.0 — heading-resolution gate (defect class 2026-08-17..20: sudoku
// 'AC-1' vs 'AC-01' zero-padding, counter container row 'AC-Doc'): every
// /^AC-/ artifact code must resolve to exactly one document heading BEFORE
// the bundle is accepted, so the freeze kernel can never terminal-fail a
// finished run on a registration/heading mismatch the worker could have
// repaired in-cell.
export const ACCEPTANCE_CONTRACT_VALIDATOR_VERSION = '1.2.0';

/**
 * Build a FormalizationCanonicalGraphPort over a raw DB handle. Reads
 * artifacts + artifact_traces directly — the same tables buildContractSnapshot
 * reads through the port in the resolver path.
 */
function graphPortFromDb(db: DbHandle): FormalizationCanonicalGraphPort {
  return {
    readArtifactsByIds(ids: readonly number[]): readonly FormalizationArtifactSnapshot[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT id, project_id AS "projectId", epic_id AS "epicId", type, code,
                status, content_hash AS "contentHash",
                accepted_hash AS "acceptedHash",
                drift_state AS "driftState", tags, metadata
           FROM artifacts WHERE id IN (${placeholders})`,
      ).all(...ids) as FormalizationArtifactSnapshot[];
    },
    readTracesByIds(ids: readonly number[]): readonly FormalizationTraceSnapshot[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT id, source_id AS "sourceArtifactId", target_type AS "targetType",
                target_id AS "targetId", link_type AS "linkType"
           FROM artifact_traces WHERE id IN (${placeholders})`,
      ).all(...ids) as FormalizationTraceSnapshot[];
    },
    readOutgoingArtifactTraces(
      sourceArtifactIds: readonly number[],
    ): readonly FormalizationTraceSnapshot[] {
      if (sourceArtifactIds.length === 0) return [];
      const placeholders = sourceArtifactIds.map(() => '?').join(',');
      return db.prepare(
        `SELECT id, source_id AS "sourceArtifactId", target_type AS "targetType",
                target_id AS "targetId", link_type AS "linkType"
           FROM artifact_traces
          WHERE source_id IN (${placeholders}
            ) AND target_type='artifact'`,
      ).all(...sourceArtifactIds) as FormalizationTraceSnapshot[];
    },
  };
}

/**
 * Read ALL formalization contract artifacts for the process run. The
 * acceptance validator needs the full contract (PRD, FR, NFR, RULE, UC, AC)
 * because it checks edges between AC and FR/NFR/UC — those target artifacts
 * were created by earlier nodes (define-product-contract, model-use-cases),
 * not by define-acceptance-contract itself. Reading only AC-managed artifacts
 * would make every AC appear to have no FR/NFR edge (the targets wouldn't be
 * in the snapshot).
 */
function readContractArtifacts(
  db: DbHandle,
  processRunId: number,
): readonly FormalizationArtifactSnapshot[] {
  return db.prepare(
    `SELECT DISTINCT a.id, a.project_id AS "projectId", a.epic_id AS "epicId",
            a.type, a.code, a.status, a.content_hash AS "contentHash",
            a.accepted_hash AS "acceptedHash", a.drift_state AS "driftState",
            a.tags, a.metadata
       FROM artifacts a
       JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
      WHERE p.process_run_id=?`,
  ).all(processRunId) as FormalizationArtifactSnapshot[];
}

/**
 * Map the aggregated gap string from findContractGap into structured
 * SubmissionGap objects. The resolver uses the string form; the validator
 * returns the structured form so the worker sees exactly which artifacts are
 * missing which edges.
 *
 * The gap string format is: "AC <id> has no derived_from → exact FR/NFR trace"
 * or "FR-derived AC <id> has no derived_from → exact UC trace".
 */
function parseGaps(
  gapString: string,
  snapshot: ReturnType<typeof buildContractSnapshot>,
): SubmissionGap[] {
  const gaps: SubmissionGap[] = [];
  const parts = gapString.split('; ');
  for (const part of parts) {
    const acMatch = part.match(/AC (\d+) has no (derived_from) → exact (FR\/NFR|UC) trace/);
    if (acMatch) {
      const artifactId = Number(acMatch[1]);
      const artifact = snapshot.artifacts.find(a => a.id === artifactId);
      const requiredTypes = acMatch[3] === 'FR/NFR' ? ['FR', 'NFR'] : ['UC'];
      const existingTargets = snapshot.traces
        .filter(t => t.sourceArtifactId === artifactId)
        .map(t => {
          const target = snapshot.targetArtifacts.find(a => a.id === t.targetId)
            ?? snapshot.artifacts.find(a => a.id === t.targetId);
          return { type: target?.type ?? '?', id: t.targetId };
        });
      gaps.push({
        artifactId,
        artifactCode: artifact?.code ?? null,
        artifactType: 'AC',
        existingTargets,
        missing: {
          relation: 'derived_from',
          requiredTargetTypes: requiredTypes,
          minimum: 1,
        },
      });
    }
  }
  return gaps;
}

/**
 * Create the acceptance-contract validator. The DB handle is injected so the
 * validator reads fresh state at validation time (not a stale snapshot).
 */
export function createAcceptanceContractValidator(
  db: DbHandle,
): NodeSubmissionValidator {
  return {
    validatorId: ACCEPTANCE_CONTRACT_VALIDATOR_ID,
    validatorVersion: ACCEPTANCE_CONTRACT_VALIDATOR_VERSION,
    validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult {
      const graph = graphPortFromDb(db);
      const artifacts = readContractArtifacts(db, input.processRunId);
      // If the worker created no AC artifacts, the resolver will catch it
      // (cardinality check). Accept here — the gap is "no ACs at all", not
      // "ACs with missing edges".
      if (!artifacts.some(a => a.type === 'AC')) {
        return acceptWithReceipt(db, input, artifacts, []);
      }
      const snapshot = buildContractSnapshot(graph, artifacts);
      // AC-drift structure network: typed-ID reverse diff first (never string
      // matching over gap prose); structural dimensions reported alongside in
      // the same rejection round.
      const coverage = readConstraintCoverageRequirement(db, input.taskId, input.processRunId);
      if (coverage) {
        const uncovered = constraintCoverageGapIdList(snapshot, coverage);
        if (uncovered.length > 0) {
          const structuralGap = findContractGap(snapshot, {
            product: true,
            useCases: true,
            acceptance: true,
          });
          return {
            accepted: false,
            code: 'FORMALIZATION_CONSTRAINT_UNCOVERED',
            gaps: [
              ...constraintCoverageSubmissionGaps(uncovered, coverage.registerTexts),
              ...(structuralGap ? parseGaps(structuralGap, snapshot) : []),
            ],
          };
        }
      }
      const gap = findContractGap(snapshot, {
        product: true,
        useCases: true,
        acceptance: true,
      });
      if (gap) {
        const structuredGaps = parseGaps(gap, snapshot);
        return {
          accepted: false,
          code: 'FORMALIZATION_ACCEPTANCE_INCOMPLETE',
          gaps: structuredGaps,
        };
      }
      // v1.2.0 heading-resolution gate: every /^AC-/ artifact code must
      // resolve to exactly one level-2/3 heading in its document BEFORE the
      // bundle is accepted. This is the SAME parse the freeze kernel uses —
      // reusing parseAtomicAcceptanceCriteria guarantees the pre-submit gate
      // and the post-hoc freeze never disagree on the heading grammar.
      // Without it a container row ('AC-Doc') or a zero-padded heading
      // ('AC-1' vs 'AC-01') sails through every cell gate and kills the run
      // at the freeze with no repair path left (2026-08-17..20 defect class:
      // sudoku, tetris, sheets, counter).
      const headingGaps = acHeadingResolutionSubmissionGaps(
        artifacts.filter(a => a.type === 'AC'),
        artifactId => readExactArtifactContent(db, artifactId),
      );
      if (headingGaps.length > 0) {
        return {
          accepted: false,
          code: 'FORMALIZATION_AC_HEADING_UNRESOLVED',
          gaps: headingGaps,
        };
      }
      const traceIds = snapshot.traces.map(t => t.id);
      return acceptWithReceipt(db, input, artifacts, traceIds);
    },
  };
}

/**
 * Submission gaps for AC artifact codes that do not resolve to exactly one
 * document heading. Fail-closed and diagnostic: the gap message carries the
 * parsed headings (capped) and BOTH legal repairs — rename/add the heading,
 * or drop the container row. Pure over (artifacts, readContent) so it is
 * unit-testable without a DB.
 */
export function acHeadingResolutionSubmissionGaps(
  acArtifacts: ReadonlyArray<{ id: number; code: string | null }>,
  readContent: (artifactId: number) => string,
): SubmissionGap[] {
  const gaps: SubmissionGap[] = [];
  for (const artifact of acArtifacts) {
    if (!artifact.code || !/^AC-/i.test(artifact.code)) continue; // 'AC' container grammar is legal
    let parsedCodes: string[] = [];
    let readError: string | null = null;
    try {
      parsedCodes = parseAtomicAcceptanceCriteria(readContent(artifact.id))
        .map(item => item.code);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    if (readError) {
      gaps.push({
        artifactId: artifact.id,
        artifactCode: artifact.code,
        artifactType: 'AC',
        existingTargets: [],
        missing: { relation: 'heading', requiredTargetTypes: [artifact.code], minimum: 1 },
        message: `AC artifact ${artifact.code} content could not be read for the`
          + ` heading-resolution check: ${readError}. Ensure the artifact file is`
          + ` committed with the registered content hash before worker_done.`,
      });
      continue;
    }
    if (parsedCodes.includes(artifact.code)) continue;
    const shown = parsedCodes.slice(0, 25).join(', ');
    const more = parsedCodes.length > 25 ? `, …(+${parsedCodes.length - 25})` : '';
    gaps.push({
      artifactId: artifact.id,
      artifactCode: artifact.code,
      artifactType: 'AC',
      existingTargets: [],
      missing: { relation: 'heading', requiredTargetTypes: [artifact.code], minimum: 1 },
      message: `AC artifact '${artifact.code}' has no matching document heading`
        + ` (parsed headings: [${shown}${more}]). Either add/rename the heading to`
        + ` exactly '${artifact.code}: <title>' (level 2-3, colon required), or —`
        + ` if '${artifact.code}' names the whole document rather than one`
        + ` criterion — remove that artifact row: a container row must not be`
        + ` registered as an atomic AC artifact.`,
    });
  }
  return gaps;
}

function acceptWithReceipt(
  _db: DbHandle,
  input: NodeSubmissionValidationInput,
  artifacts: readonly FormalizationArtifactSnapshot[],
  traceIds: readonly number[],
): NodeSubmissionValidationResult {
  const artifactIds = artifacts.map(a => a.id);
  // Capture content hashes at validation time so a post-hoc mutation is
  // detectable by recomputing the digest against current state. ID-only
  // digests could not detect content mutation.
  const artifactHashes: Record<string, string> = {};
  for (const a of artifacts) {
    if (a.contentHash) artifactHashes[String(a.id)] = a.contentHash;
  }
  const sortedTraceIds = [...traceIds].sort((a, b) => a - b);
  const traceDigest = sha256Hex(sortedTraceIds);
  const validatedSetDigest = sha256Hex({
    artifactIds: [...artifactIds].sort((a, b) => a - b),
    artifactHashes,
    traceIds: sortedTraceIds,
  });
  const receipt: SubmissionValidationReceipt = {
    validatorId: ACCEPTANCE_CONTRACT_VALIDATOR_ID,
    validatorVersion: ACCEPTANCE_CONTRACT_VALIDATOR_VERSION,
    processRunId: input.processRunId,
    moduleRef: input.moduleRef,
    nodeId: input.nodeId,
    executionId: input.executionId,
    taskId: input.taskId,
    inputSnapshotHash: validatedSetDigest,
    artifactIds,
    traceIds,
    artifactHashes,
    traceDigest,
    validatedSetDigest,
    contractRef: input.contractRef,
    validatedAt: new Date().toISOString(),
  };
  return { accepted: true, receipt };
}
