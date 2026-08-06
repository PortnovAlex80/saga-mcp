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

export const SRS_CONTRACT_VALIDATOR_ID = 'formalization.srs-contract.v1';

/**
 * The set of valid criticality values — read from the canonical contract,
 * never duplicated. If the contract enum changes, this set changes with it.
 */
const VALID_CRITICALITY = new Set<string>(SRS_CONTRACT.d2EnumFields.criticality);
const VALID_AC_KIND = new Set<string>(SRS_CONTRACT.d2EnumFields.ac_kind);
const VALID_PATTERN = new Set<string>(SRS_CONTRACT.d2EnumFields.pattern);

/**
 * Required fields in every §D2 stanza, per the canonical contract.
 */
const D2_REQUIRED_FIELDS: readonly string[] = SRS_CONTRACT.d2RequiredFields;

/**
 * Decision Log: the canonical column set. Every §12 table row must have at
 * least this many columns (table header row defines the shape).
 */
const DECISION_LOG_COLUMNS: readonly string[] = SRS_CONTRACT.decisionLogColumns;

/**
 * A parsed §D2 stanza: the YAML key/value pairs for one AC row.
 */
interface D2Stanza {
  readonly ac: string;
  readonly fields: ReadonlyMap<string, string>;
}

/**
 * Create the SRS contract validator. Reads the SRS document from disk (via
 * project_repository.local_path + artifact.path) to perform structural checks.
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
      const section12Gap = checkDecisionLog(fileContent, srs.id);
      if (section12Gap) gaps.push(section12Gap);

      // --- 7. §D2 stanzas: required fields + enum validity (T1.3, T1.4) ---
      const d2Gaps = checkD2Stanzas(fileContent, srs.id);
      gaps.push(...d2Gaps);

      return rejectOrAccept(input, srs, fileHash, gaps);
    },
  };
}

// ---------------------------------------------------------------------------
// §12 Decision Log check.
// ---------------------------------------------------------------------------

/**
 * Check the §12 Decision Log section exists and its table header has at least
 * the canonical column count. The columns themselves are matched loosely by
 * header text (the canonical names are stable, but reviewers may write
 * human-readable variants).
 */
function checkDecisionLog(content: string, srsId: number): SubmissionGap | null {
  const sectionMatch = content.match(/§\s*12[^\n]*\n([\s\S]*?)(?=\n##\s|\n###\s[^#]|$)/i)
    ?? content.match(/##\s*.*Decision Log[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sectionMatch) {
    return {
      artifactId: srsId,
      artifactCode: null,
      artifactType: 'SRS',
      existingTargets: [],
      missing: {
        relation: 'section',
        requiredTargetTypes: ['§12 Decision Log'],
        minimum: 1,
      },
    };
  }
  const sectionBody = sectionMatch[1] ?? '';
  // Find the first markdown table header row in the section.
  const tableHeaderMatch = sectionBody.match(/\|([^\n]*\|)+/);
  if (!tableHeaderMatch) {
    return {
      artifactId: srsId,
      artifactCode: null,
      artifactType: 'SRS',
      existingTargets: [],
      missing: {
        relation: 'decision-log-table',
        requiredTargetTypes: [`markdown table with ≥${DECISION_LOG_COLUMNS.length} columns`],
        minimum: 1,
      },
    };
  }
  const headerCells = (tableHeaderMatch[0] ?? '')
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0 && !/^[-:]+$/.test(cell));
  if (headerCells.length < DECISION_LOG_COLUMNS.length) {
    return {
      artifactId: srsId,
      artifactCode: null,
      artifactType: 'SRS',
      existingTargets: headerCells.map((_c, i) => ({ type: 'column', id: i })),
      missing: {
        relation: 'decision-log-columns',
        requiredTargetTypes: [...DECISION_LOG_COLUMNS],
        minimum: DECISION_LOG_COLUMNS.length,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// §D2 stanza parser + checker.
// ---------------------------------------------------------------------------

/**
 * Extract the §D2 YAML code block from the SRS markdown, parse it into
 * stanzas (one per AC), and validate each stanza against the canonical
 * contract's required fields and enum constraints.
 *
 * Parsing strategy: the §D2 block is a markdown fenced code block (```yaml).
 * Each stanza is a top-level list item starting with `- ac:`. We split on
 * that marker and parse `key: value` lines within each stanza. This is a
 * deliberately lightweight parser — it does not depend on a YAML library and
 * only needs to find field names and their (scalar) values to check presence
 * and enum membership.
 */
function checkD2Stanzas(content: string, srsId: number): SubmissionGap[] {
  const gaps: SubmissionGap[] = [];
  const stanzas = extractD2Stanzas(content);
  if (stanzas.length === 0) {
    gaps.push({
      artifactId: srsId,
      artifactCode: null,
      artifactType: 'SRS',
      existingTargets: [],
      missing: {
        relation: 'd2-stanzas',
        requiredTargetTypes: ['≥1 §D2 stanza with `ac:` field'],
        minimum: 1,
      },
    });
    return gaps;
  }
  for (const stanza of stanzas) {
    // Required fields presence.
    for (const field of D2_REQUIRED_FIELDS) {
      if (!stanza.fields.has(field)) {
        gaps.push({
          artifactId: srsId,
          artifactCode: stanza.ac,
          artifactType: 'SRS',
          existingTargets: [...stanza.fields.keys()].map((k, i) => ({ type: k, id: i })),
          missing: {
            relation: 'd2-field',
            requiredTargetTypes: [field],
            minimum: 1,
          },
        });
      }
    }
    // Enum field validity.
    const acKind = stanza.fields.get('ac_kind');
    if (acKind && !VALID_AC_KIND.has(acKind)) {
      gaps.push(enumGap(srsId, stanza.ac, 'ac_kind', acKind, SRS_CONTRACT.d2EnumFields.ac_kind));
    }
    const pattern = stanza.fields.get('pattern');
    if (pattern && !VALID_PATTERN.has(pattern)) {
      gaps.push(enumGap(srsId, stanza.ac, 'pattern', pattern, SRS_CONTRACT.d2EnumFields.pattern));
    }
    const criticality = stanza.fields.get('criticality');
    if (criticality && !VALID_CRITICALITY.has(criticality)) {
      gaps.push(enumGap(srsId, stanza.ac, 'criticality', criticality, SRS_CONTRACT.d2EnumFields.criticality));
    }
  }
  return gaps;
}

function enumGap(
  srsId: number,
  acCode: string,
  field: string,
  _value: string,
  allowed: readonly string[],
): SubmissionGap {
  return {
    artifactId: srsId,
    artifactCode: acCode,
    artifactType: 'SRS',
    existingTargets: [{ type: field, id: -1 }],
    missing: {
      relation: 'valid-enum-value',
      requiredTargetTypes: [...allowed],
      minimum: 1,
    },
  };
}

/**
 * Extract §D2 stanzas from the SRS markdown content. Returns one D2Stanza per
 * `- ac:` list item found inside the §D2 fenced code block.
 */
function extractD2Stanzas(content: string): D2Stanza[] {
  // Locate the §D2 section. It starts at a header line containing "§D2" or
  // "D2" and ends at the next section header of the same or higher level.
  const sectionStart = content.search(/#{2,4}\s*§?\s*D2\b/);
  if (sectionStart === -1) return [];
  const afterStart = content.slice(sectionStart);
  // The section ends at the next `##` or `###` header that is NOT the §D2
  // header itself. Find the next header after the first line.
  const nextHeaderMatch = afterStart.slice(afterStart.indexOf('\n')).match(/\n#{2,4}\s/);
  const sectionText = nextHeaderMatch
    ? afterStart.slice(0, afterStart.indexOf('\n') + (nextHeaderMatch.index ?? 0))
    : afterStart;
  // Extract the fenced code block (```yaml ... ```).
  const codeBlockMatch = sectionText.match(/```[a-z]*\n([\s\S]*?)```/i);
  if (!codeBlockMatch) return [];
  const yaml = codeBlockMatch[1] ?? '';
  // Split into stanzas on top-level `- ac:` markers. Each stanza starts at a
  // line beginning with `- ac:` (possibly preceded by whitespace, but we
  // treat only 0-indent as top-level to avoid nested list items).
  const lines = yaml.split('\n');
  const stanzas: D2Stanza[] = [];
  let currentAc: string | null = null;
  let currentFields: Map<string, string> = new Map();
  for (const line of lines) {
    const stanzaStart = line.match(/^-\s+ac:\s*(\S+)/);
    if (stanzaStart) {
      if (currentAc) {
        stanzas.push({ ac: currentAc, fields: currentFields });
      }
      currentAc = stanzaStart[1]!.replace(/["']/g, '');
      currentFields = new Map();
      // The `ac` field itself is on the stanza-start line; record it so the
      // required-field check sees it as present.
      currentFields.set('ac', currentAc);
      continue;
    }
    if (currentAc) {
      // Parse `key: value` lines (scalar values only). The YAML block uses
      // 2-space indentation for top-level stanza fields, so allow optional
      // leading whitespace. Nested list items (e.g. conflict_keys entries)
      // start with `-` and are ignored — we only need scalar field presence.
      const fieldMatch = line.match(/^\s+(\w[\w_]*)\s*:\s*(.*)$/);
      if (fieldMatch) {
        const [, key, rawValue] = fieldMatch;
        const value = (rawValue ?? '').trim().replace(/["']/g, '').replace(/#.*$/, '').trim();
        if (!currentFields.has(key!)) {
          currentFields.set(key!, value);
        }
      }
    }
  }
  if (currentAc) {
    stanzas.push({ ac: currentAc, fields: currentFields });
  }
  return stanzas;
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
