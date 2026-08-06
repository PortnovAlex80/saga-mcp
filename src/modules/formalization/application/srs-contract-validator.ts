/**
 * Formalization SRS contract submission validator.
 *
 * Shifts the SRS structural check from the post-hoc reviewer to the
 * worker_done boundary. The worker is told structural gaps BEFORE it leaves,
 * so it can fix and retry without burning a recovery epoch.
 *
 * Single source of truth: ALL enums, required fields and column lists come
 * from SRS_CONTRACT (../domain/srs-contract.ts). This validator has NO
 * duplicate lists of its own — it cannot drift out of sync with the canonical
 * contract by construction (T1.4).
 *
 * Fail-closed policy (T1.2): every "missing" condition is a REJECT, not a
 * silent accept. No SRS, no repository, no file, file/hash mismatch → reject.
 * The previous fail-open behaviour (accept when SRS is missing, "resolver will
 * catch") caused the exact problem the shift-left gate exists to prevent:
 * worker_done accepted → expensive worker released → next node discovers the
 * product is absent.
 *
 * What this validator checks (structural):
 *   - SRS artifact exists for the process run
 *   - SRS → PRD derived_from trace exists
 *   - Repository binding exists; SRS file exists on disk
 *   - sha256(file content) === artifact.content_hash (byte-level integrity)
 *   - §12 Decision Log section exists, with ≥ the required columns
 *   - §D2 stanzas exist; each has every required field; enum fields valid
 *   - criticality present and valid in every §D2 stanza (REQUIRED)
 *   - contractRef: if the caller pins a contract version, it must match
 *     SRS_CONTRACT_REF — otherwise SRS_CONTRACT_VERSION_MISMATCH
 *
 * What it does NOT check (left to reviewer):
 *   - Semantic coverage of activated decision categories
 *   - Quality of architecture decisions
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../../shared/canonical-json.js';

/**
 * Driver-neutral database handle alias. The module never imports better-sqlite3
 * directly — the concrete handle is constructor-injected by infrastructure
 * (src/infrastructure/). This keeps the module's application contract free of
 * the SQLite driver type (Wave 7 architecture test: no-sqlite-in-modules).
 */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}
import type {
  NodeSubmissionValidationInput,
  NodeSubmissionValidationResult,
  NodeSubmissionValidator,
  SubmissionGap,
  SubmissionValidationReceipt,
} from '../../../process-modules/application/node-submission-policy.js';
import {
  SRS_CONTRACT_REF,
} from '../domain/srs-contract.js';
import {
  extractD2Stanzas,
  validateD2Structure,
  checkDecisionLogSection,
} from './srs-d2-parser.js';

export const SRS_CONTRACT_VALIDATOR_ID = 'formalization.srs-contract.v1';

/**
 * Create the SRS contract validator. Reads the SRS document from disk (via
 * project_repository.local_path + artifact.path) to perform structural checks.
 *
 * Structural validation logic (§D2 parsing, §12 check, enum validation) lives
 * in srs-d2-parser.ts and is shared with the Production Cell CheckProvider —
 * no duplication between the worker_done preflight and the gate.
 */
export function createSrsContractValidator(
  db: DbHandle,
): NodeSubmissionValidator {
  return {
    validatorId: SRS_CONTRACT_VALIDATOR_ID,
    validatorVersion: '1.0.0',
    validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult {
      const gaps: SubmissionGap[] = [];

      // --- Contract ref mismatch check (T1.6) ---
      // If the caller pins a contract version on the input, it must match the
      // canonical SRS_CONTRACT_REF this validator was built against. A mismatch
      // means the author produced the SRS under one contract version and the
      // reviewer/validator is checking under another — that is never a
      // changes_requested situation; it is a configuration error.
      if (input.contractRef) {
        if (
          input.contractRef.version !== SRS_CONTRACT_REF.version
          || input.contractRef.digest !== SRS_CONTRACT_REF.digest
        ) {
          return {
            accepted: false,
            code: 'SRS_CONTRACT_VERSION_MISMATCH',
            gaps: [{
              artifactId: -1,
              artifactCode: null,
              artifactType: 'SRS_CONTRACT',
              existingTargets: [{
                type: 'contractRef',
                id: -1,
              }],
              missing: {
                relation: 'contract-version-match',
                requiredTargetTypes: [
                  `v${SRS_CONTRACT_REF.version} (${SRS_CONTRACT_REF.digest.slice(0, 12)})`,
                ],
                minimum: 1,
              },
            }],
          };
        }
      }

      // --- 1. SRS artifact must exist (fail-closed, T1.2) ---
      const srs = db.prepare(
        `SELECT a.id, a.path, a.project_repository_id, a.content_hash
           FROM artifacts a
           JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
          WHERE p.process_run_id=? AND a.type='SRS'
          ORDER BY a.id DESC LIMIT 1`,
      ).get(input.processRunId) as {
        id: number; path: string; project_repository_id: number; content_hash: string;
      } | undefined;

      if (!srs) {
        // Fail-closed: no SRS produced → reject. The resolver no longer needs
        // to "catch this later" — the worker is told now.
        return {
          accepted: false,
          code: 'FORMALIZATION_SRS_MISSING',
          gaps: [{
            artifactId: -1,
            artifactCode: null,
            artifactType: 'SRS',
            existingTargets: [],
            missing: {
              relation: 'artifact-exists',
              requiredTargetTypes: ['SRS'],
              minimum: 1,
            },
          }],
        };
      }

      // --- 2. SRS → PRD derived_from trace ---
      const hasPrdTrace = db.prepare(
        `SELECT 1 FROM artifact_traces t
          JOIN artifacts a ON a.id = t.target_id
          WHERE t.source_id=? AND t.link_type='derived_from' AND a.type='PRD'`,
      ).get(srs.id);
      if (!hasPrdTrace) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [],
          missing: {
            relation: 'derived_from',
            requiredTargetTypes: ['PRD'],
            minimum: 1,
          },
        });
      }

      // --- 3. Repository binding must exist (fail-closed, T1.2) ---
      const repo = db.prepare(
        'SELECT local_path FROM project_repositories WHERE id=?',
      ).get(srs.project_repository_id) as { local_path: string } | undefined;

      if (!repo || !repo.local_path) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [],
          missing: {
            relation: 'repository-binding',
            requiredTargetTypes: ['project_repository.local_path'],
            minimum: 1,
          },
        });
        // Without a repo path we cannot read the file — return what we have.
        return rejectOrAccept(input, srs, null, gaps);
      }

      // --- 4. SRS file must exist on disk (fail-closed, T1.2) ---
      const srsFilePath = path.join(repo.local_path, srs.path.split('#')[0]!);
      if (!existsSync(srsFilePath)) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [],
          missing: {
            relation: 'file-exists',
            requiredTargetTypes: [srs.path],
            minimum: 1,
          },
        });
        return rejectOrAccept(input, srs, null, gaps);
      }

      // --- 5. File content hash must match artifact.content_hash (T1.2) ---
      const fileContent = readFileSync(srsFilePath, 'utf8');
      const fileHash = createHash('sha256').update(fileContent, 'utf8').digest('hex');
      if (fileHash !== srs.content_hash) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [{
            type: 'content_hash',
            id: srs.id,
          }],
          missing: {
            relation: 'file-hash-match',
            requiredTargetTypes: [`sha256=${srs.content_hash.slice(0, 16)}`],
            minimum: 1,
          },
        });
        // Hash mismatch is a hard stop — further content checks would run
        // against a file that does not match the registered artifact.
        return rejectOrAccept(input, srs, fileHash, gaps);
      }

      // --- 6. §12 Decision Log section + columns (T1.3) ---
      const decisionLogGap = checkDecisionLogSection(fileContent);
      if (decisionLogGap) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [],
          missing: {
            relation: decisionLogGap.includes('columns') ? 'decision-log-columns' : 'section',
            requiredTargetTypes: ['§12 Decision Log'],
            minimum: 1,
          },
        });
      }

      // --- 7. §D2 stanzas: required fields + enum validity (T1.3, T1.4) ---
      const stanzas = extractD2Stanzas(fileContent);
      if (stanzas.length === 0) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [],
          missing: {
            relation: 'd2-stanzas',
            requiredTargetTypes: ['≥1 §D2 stanza with `ac:` field'],
            minimum: 1,
          },
        });
      } else {
        // Reuse the shared structural validator from srs-d2-parser.
        const d2Gaps = validateD2Structure(fileContent);
        for (const gap of d2Gaps) {
          gaps.push({
            artifactId: srs.id,
            artifactCode: gap.ac,
            artifactType: 'SRS',
            existingTargets: [{ type: gap.field, id: -1 }],
            missing: {
              relation: gap.kind === 'invalid-enum-value' ? 'valid-enum-value' : 'd2-field',
              requiredTargetTypes: gap.allowedValues ?? [gap.field],
              minimum: 1,
            },
          });
        }
      }

      return rejectOrAccept(input, srs, fileHash, gaps);
    },
  };
}

// ---------------------------------------------------------------------------
// Result helpers.
// ---------------------------------------------------------------------------

/**
 * Build a reject (if gaps present) or accept-with-receipt result. The receipt
 * captures the SRS artifact id + its content hash at validation time, so a
 * post-hoc mutation of the artifact content is detectable by recomputing the
 * digest against current state.
 *
 * `fileHash` is the hash of the file bytes actually read from disk. When
 * non-null it MUST equal `srs.content_hash` (checked earlier); when null the
 * validator could not read the file and is rejecting on a prior gap.
 */
function rejectOrAccept(
  input: NodeSubmissionValidationInput,
  srs: { id: number; content_hash: string },
  fileHash: string | null,
  gaps: SubmissionGap[],
): NodeSubmissionValidationResult {
  if (gaps.length > 0) {
    return {
      accepted: false,
      code: 'FORMALIZATION_SRS_INCOMPLETE',
      gaps,
    };
  }
  const artifactIds = [srs.id];
  const artifactHashes: Record<string, string> = {
    [String(srs.id)]: fileHash ?? srs.content_hash,
  };
  const validatedSetDigest = sha256Hex({
    artifactIds,
    artifactHashes,
    traceIds: [],
  });
  const receipt: SubmissionValidationReceipt = {
    validatorId: SRS_CONTRACT_VALIDATOR_ID,
    validatorVersion: '1.0.0',
    processRunId: input.processRunId,
    moduleRef: input.moduleRef,
    nodeId: input.nodeId,
    executionId: input.executionId,
    taskId: input.taskId,
    inputSnapshotHash: validatedSetDigest,
    artifactIds,
    traceIds: [],
    artifactHashes,
    traceDigest: '',
    validatedSetDigest,
    contractRef: input.contractRef,
    validatedAt: new Date().toISOString(),
  };
  return { accepted: true, receipt };
}
