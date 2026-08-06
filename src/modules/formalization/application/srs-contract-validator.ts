/**
 * Formalization SRS contract submission validator.
 *
 * Shifts the SRS structural check (§12 Decision Log exists, criticality valid
 * if present, SRS→PRD trace exists) from the post-hoc reviewer to the
 * worker_done boundary. The worker is told structural gaps BEFORE it leaves,
 * so it can fix and retry without burning a recovery epoch.
 *
 * What this validator checks (structural only — semantic coverage is the
 * reviewer's job):
 *   - SRS artifact exists for the process run
 *   - SRS → PRD derived_from trace exists
 *   - §12 Decision Log section exists in the SRS document
 *   - criticality: if present in §D2, value must be valid enum
 *
 * What it does NOT check (left to reviewer):
 *   - Semantic coverage of activated decision categories
 *   - Quality of architecture decisions
 *   - §10/§11 completeness for L/XL
 *   - Security review
 */

import type Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  NodeSubmissionValidationInput,
  NodeSubmissionValidationResult,
  NodeSubmissionValidator,
  SubmissionGap,
  SubmissionValidationReceipt,
} from '../../../process-modules/application/node-submission-policy.js';

export const SRS_CONTRACT_VALIDATOR_ID = 'formalization.srs-contract.v1';

const VALID_CRITICALITY = new Set(['blocker', 'degradable', 'nice-to-have']);

/**
 * Create the SRS contract validator. Reads the SRS document from disk (via
 * project_repository.local_path + artifact.path) to check §12 presence.
 */
export function createSrsContractValidator(
  db: Database.Database,
): NodeSubmissionValidator {
  return {
    validatorId: SRS_CONTRACT_VALIDATOR_ID,
    validatorVersion: '1.0.0',
    validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult {
      const gaps: SubmissionGap[] = [];

      // 1. Find SRS artifact produced by this process run.
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
        // No SRS produced — resolver will catch this. Accept (not a structural
        // gap the validator can describe).
        return acceptWithReceipt(input, [], []);
      }

      // 2. Check SRS → PRD derived_from trace.
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

      // 3. Check §12 Decision Log in the SRS document.
      const repo = db.prepare(
        'SELECT local_path FROM project_repositories WHERE id=?',
      ).get(srs.project_repository_id) as { local_path: string } | undefined;

      if (repo?.local_path) {
        const srsPath = path.join(repo.local_path, srs.path.split('#')[0]!);
        if (existsSync(srsPath)) {
          const content = readFileSync(srsPath, 'utf8');
          const hasSection12 = /§\s*12|##.*Decision Log/i.test(content);
          if (!hasSection12) {
            gaps.push({
              artifactId: srs.id,
              artifactCode: null,
              artifactType: 'SRS',
              existingTargets: [],
              missing: {
                relation: 'section',
                requiredTargetTypes: ['§12 Decision Log'],
                minimum: 1,
              },
            });
          }
        }
      }

      // 4. Check criticality validity (required, authoritative end-to-end).
      const d2Rows = db.prepare(
        `SELECT a.id, a.code FROM artifacts a
          JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
          WHERE p.process_run_id=? AND a.type='AC'`,
      ).all(input.processRunId) as Array<{ id: number; code: string | null }>;

      // Read §D2 YAML from SRS to check criticality.
      if (repo?.local_path && gaps.length === 0) {
        const srsPath = path.join(repo.local_path, srs.path.split('#')[0]!);
        if (existsSync(srsPath)) {
          const content = readFileSync(srsPath, 'utf8');
          // Extract criticality values from YAML §D2 rows.
          const criticalityMatches = content.matchAll(/criticality:\s*(\S+)/g);
          for (const match of criticalityMatches) {
            const value = match[1]!.replace(/["']/g, '');
            if (!VALID_CRITICALITY.has(value)) {
              gaps.push({
                artifactId: srs.id,
                artifactCode: null,
                artifactType: 'SRS',
                existingTargets: [{ type: 'criticality', id: -1 }],
                missing: {
                  relation: 'valid-enum-value',
                  requiredTargetTypes: ['blocker', 'degradable', 'nice-to-have'],
                  minimum: 1,
                },
              });
            }
          }
        }
      }

      if (gaps.length > 0) {
        return {
          accepted: false,
          code: 'FORMALIZATION_SRS_INCOMPLETE',
          gaps,
        };
      }

      const artifactIds = [srs.id, ...d2Rows.map(r => r.id)];
      return acceptWithReceipt(input, artifactIds, []);
    },
  };
}

function acceptWithReceipt(
  input: NodeSubmissionValidationInput,
  artifactIds: number[],
  traceIds: number[],
): NodeSubmissionValidationResult {
  const validatedSetDigest = sha256Hex({
    artifactIds: [...artifactIds].sort((a, b) => a - b),
    traceIds: [...traceIds].sort((a, b) => a - b),
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
    traceIds,
    validatedSetDigest,
    validatedAt: new Date().toISOString(),
  };
  return { accepted: true, receipt };
}
