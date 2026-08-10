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
  SRS_CONTRACT,
  SRS_CONTRACT_REF,
} from '../domain/srs-contract.js';
import {
  extractD2Stanzas,
  validateD2Structure,
  checkDecisionLogSection,
} from './srs-d2-parser.js';

export const SRS_CONTRACT_VALIDATOR_ID = 'formalization.srs-contract.v1';
/**
 * Canonical provider protocol identity imported by the Formalization check
 * plan. Contract semantics are versioned independently by SRS_CONTRACT_REF
 * (currently v2.2); the plan must never duplicate this protocol version.
 */
export const SRS_CONTRACT_VALIDATOR_VERSION = '1.1.0';

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
    validatorVersion: SRS_CONTRACT_VALIDATOR_VERSION,
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
          message: decisionLogGap,
        });
      }

      // --- 7. §D2 representation + exact frozen-AC binding (T1.3, T1.4) ---
      const stanzas = extractD2Stanzas(fileContent);
      const d2Gaps = validateD2Structure(fileContent);
      for (const gap of d2Gaps) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: gap.ac,
          artifactType: 'SRS',
          existingTargets: [{ type: gap.field, id: -1 }],
          missing: {
            relation: d2GapRelation(gap.kind),
            requiredTargetTypes: gap.allowedValues ?? [gap.field],
            minimum: 1,
          },
          message: gap.message,
        });
      }

      const baseline = readFrozenBaseline(db, input.processRunId);
      if (!baseline) {
        gaps.push({
          artifactId: srs.id,
          artifactCode: null,
          artifactType: 'SRS',
          existingTargets: [],
          missing: {
            relation: 'frozen-acceptance-baseline',
            requiredTargetTypes: ['factory.acceptance-baseline-snapshot.v1'],
            minimum: 1,
          },
          message: `ProcessRun ${input.processRunId} has no readable frozen acceptance baseline.`,
        });
      } else {
        const actualCodes = stanzas.map(stanza => stanza.ac);
        const actualSet = new Set(actualCodes);
        const expectedSet = new Set(baseline.acceptanceCriteria.map(item => item.code));
        for (const expected of baseline.acceptanceCriteria) {
          if (!actualSet.has(expected.code)) {
            gaps.push({
              artifactId: expected.artifactId,
              artifactCode: expected.code,
              artifactType: 'AC',
              existingTargets: [],
              missing: {
                relation: 'represented_by',
                requiredTargetTypes: [`§D2 stanza ac: ${expected.code}`],
                minimum: 1,
              },
              message: `Frozen ${expected.code} is missing from §D2. Use the exact frozen AC code once.`,
            });
          }
        }
        for (const actual of actualSet) {
          if (!expectedSet.has(actual)) {
            gaps.push({
              artifactId: srs.id,
              artifactCode: actual,
              artifactType: 'SRS',
              existingTargets: [],
              missing: {
                relation: 'exact-frozen-ac-code',
                requiredTargetTypes: baseline.acceptanceCriteria.map(item => item.code),
                minimum: 1,
              },
              message: `§D2 code ${actual} is not in the frozen baseline and cannot be substituted or expanded into sub-criteria.`,
            });
          }
        }
      }

      const details = {
        decisionLogRepresentation: 'one §12 Decision Log heading followed by either a markdown table with the six canonical columns or one or more `### Decision N` subsections',
        requiredDecisionLogColumns: [...SRS_CONTRACT.decisionLogColumns],
        canonicalDecisionLogExample: [
          '## §12 Decision Log',
          '',
          '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
          '|---|----------|----------------|-------------------------|-----------|------|',
          '| 1 | Modular monolith | local | layered monolith, services | Fits bounded local scope | 2026-08-11 |',
        ].join('\n'),
        representation: 'one explicit §D2 AC Map/Decomposition heading with exactly one fenced YAML block',
        requiredD2Fields: [...SRS_CONTRACT.d2RequiredFields],
        d2Enums: SRS_CONTRACT.d2EnumFields,
        expectedAcCodes: baseline?.acceptanceCriteria.map(item => item.code) ?? [],
        actualAcCodes: stanzas.map(stanza => stanza.ac),
        baselineHash: baseline?.baselineHash ?? null,
        baselineSnapshotHash: baseline?.snapshotHash ?? null,
        srsArtifactId: srs.id,
        observedSrsFileHash: fileHash,
        canonicalExample: [
          '## §D2 AC Map',
          '```yaml',
          '- ac: AC-1',
          '  title: Exact frozen AC title',
          '  module: core',
          '  files: [src/core.ts]',
          '  invariants: [INV-1]',
          '  test_layers: [L0]',
          '  pattern: A',
          '  depends_on: []',
          '  ac_kind: implementation',
          '  criticality: blocker',
          '```',
        ].join('\n'),
      };

      return rejectOrAccept(input, srs, fileHash, gaps, details);
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
  details: Readonly<Record<string, unknown>> = {},
): NodeSubmissionValidationResult {
  if (gaps.length > 0) {
    return {
      accepted: false,
      code: 'FORMALIZATION_SRS_INCOMPLETE',
      gaps,
      details,
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
    validatorVersion: SRS_CONTRACT_VALIDATOR_VERSION,
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

function d2GapRelation(kind: string): string {
  if (kind === 'invalid-enum-value') return 'valid-enum-value';
  if (kind === 'invalid-representation') return 'd2-representation';
  if (kind === 'duplicate-field' || kind === 'duplicate-ac') return 'd2-uniqueness';
  if (kind === 'malformed-yaml-line') return 'd2-yaml-syntax';
  return 'd2-field';
}

interface FrozenBaselineView {
  readonly baselineHash: string;
  readonly snapshotHash: string;
  readonly acceptanceCriteria: readonly {
    artifactId: number;
    code: string;
    contentHash: string;
  }[];
}

function readFrozenBaseline(db: DbHandle, processRunId: number): FrozenBaselineView | null {
  let row: { payload: string; baseline_hash: string; snapshot_hash: string } | undefined;
  try {
    row = db.prepare(
      `SELECT payload, baseline_hash, snapshot_hash
         FROM factory_formalization_acceptance_baselines
        WHERE process_run_id=?`,
    ).get(processRunId) as typeof row;
  } catch {
    return null;
  }
  if (!row) return null;
  let payload: { acArtifactIds?: unknown; acArtifactHashes?: unknown };
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    return null;
  }
  if (!Array.isArray(payload.acArtifactIds) || payload.acArtifactIds.length === 0) return null;
  const ids = payload.acArtifactIds.filter(
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  );
  if (ids.length !== payload.acArtifactIds.length) return null;
  const placeholders = ids.map(() => '?').join(',');
  const artifacts = db.prepare(
    `SELECT id, code, content_hash, accepted_hash, status
       FROM artifacts WHERE id IN (${placeholders})`,
  ).all(...ids) as Array<{
    id: number;
    code: string | null;
    content_hash: string | null;
    accepted_hash: string | null;
    status: string;
  }>;
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  const expectedHashes = payload.acArtifactHashes && typeof payload.acArtifactHashes === 'object'
    ? payload.acArtifactHashes as Record<string, unknown>
    : {};
  const acceptanceCriteria = ids.map(id => {
    const artifact = byId.get(id);
    const expectedHash = expectedHashes[String(id)];
    if (
      !artifact
      || typeof artifact.code !== 'string'
      || artifact.code.trim() === ''
      || artifact.status !== 'accepted'
      || typeof expectedHash !== 'string'
      || artifact.content_hash !== expectedHash
      || artifact.accepted_hash !== expectedHash
    ) return null;
    return { artifactId: id, code: artifact.code, contentHash: expectedHash };
  });
  if (acceptanceCriteria.some(item => item === null)) return null;
  return {
    baselineHash: row.baseline_hash,
    snapshotHash: row.snapshot_hash,
    acceptanceCriteria: acceptanceCriteria as FrozenBaselineView['acceptanceCriteria'],
  };
}
