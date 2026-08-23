/**
 * Shared reader for the AC-drift coverage inputs: the constraint register
 * resolved from the FormalizationCase (which rides the task's frozen
 * process_node_input) plus the validly-waived IDs from the accepted brief's
 * constraint_dispositions metadata.
 *
 * One reader, three consumers (acceptance validator, reconciliation
 * validator, SRS validator) — the diff itself lives in
 * formalization-contract-analysis.ts, so the worker_done gate and the
 * resolver can never disagree on what "covered" means.
 */

import type { FormalizationCase } from '../domain/formalization-schemas.js';
import {
  FORMALIZATION_CASE_SCHEMA,
  resolveFormalizationCaseConstraintRegister,
  resolveFormalizationCaseRegisterAuthority,
  waivedConstraintIdsForRegister,
  type FormalizationCaseRegisterAuthority,
} from '../domain/formalization-schemas.js';
import type {
  ConstraintCoverageRequirement,
} from './formalization-contract-analysis.js';

/**
 * Driver-neutral database handle alias. See srs-contract-validator.ts for
 * rationale (Wave 7 architecture test: no-sqlite-in-modules).
 */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

/**
 * ADR-090 (CC-IC-2): resolve the register authority a formalization gate
 * diffs against, CERTIFICATE-FIRST — the same v2 source of truth the
 * settlement resolves (`resolveFormalizationCaseRegisterAuthority`). One
 * resolution site shared by the A1 disposition gate and the A2 coverage
 * readers, so the gates can never diff against different registers.
 *
 * Resolution:
 *  - the discovery certificate row resolves and hash-verifies against the
 *    case pin → the certificate register binding (or the typed no-obligations
 *    attestation — the lawful null);
 *  - the certificate TABLE does not exist on this host (legacy corpus
 *    fixtures seed v1 cases with certificate-shaped refs on hosts whose
 *    schema never created the table — the frozen-legacy exception; a missing
 *    table is indistinguishable from a legacy host) → the frozen-legacy-v1
 *    deterministic rebuild, bit-identical with the pre-CC-IC-2 gate;
 *  - the table exists but the pinned ROW is missing → a typed red. A
 *    certificate-shaped ref names a specific row; when that row is absent
 *    the pinned authority does not resolve, and the gate must NEVER fall
 *    back to a rebuild it cannot verify (the settlement-side resolver
 *    `resolveCaseRegisterAuthority` already fails closed the same way with
 *    FORMALIZATION_DISCOVERY_CERTIFICATE_MISSING);
 *  - the row exists but diverges from the case pin (hash mismatch / binding
 *    bypass / malformed payload) → a typed red — never a silent fallback that
 *    would diff against a different register than the one the freeze rides.
 */
export function resolveRegisterAuthorityForCoverage(
  db: DbHandle,
  formalizationCase: FormalizationCase,
): { ok: true; authority: FormalizationCaseRegisterAuthority | null }
| { ok: false; code: string; message: string } {
  const ref = formalizationCase.discoveryCertificateRef;
  const match = /^certificate:(\d+)$/.exec(ref);
  if (!match) {
    return {
      ok: true,
      authority: {
        binding: resolveFormalizationCaseConstraintRegister(formalizationCase),
        attestation: null,
      },
    };
  }
  const certificateId = Number(match[1]);
  let row: { certificate_payload?: unknown; certificate_hash?: unknown } | undefined;
  try {
    row = db.prepare(
      `SELECT certificate_payload, certificate_hash
         FROM factory_process_outcome_certificates WHERE id=?`,
    ).get(certificateId) as { certificate_payload?: unknown; certificate_hash?: unknown }
      | undefined;
  } catch {
    // No certificate table on this host (legacy corpus): frozen-legacy-v1
    // rebuild fallback — bit-identical with the pre-CC-IC-2 gate.
    return {
      ok: true,
      authority: {
        binding: resolveFormalizationCaseConstraintRegister(formalizationCase),
        attestation: null,
      },
    };
  }
  if (!row) {
    // CC-IC-2 fail-closed review: the certificate table EXISTS but the
    // pinned row is missing. A certificate-shaped ref names a specific
    // authority row; when it does not resolve, diffing against an
    // unverifiable rebuild is exactly the silent-fallback hole — typed red
    // (mirrors the settlement resolver's FORMALIZATION_DISCOVERY_CERTIFICATE_
    // MISSING). The only lawful legacy fallback is the missing-TABLE branch
    // above (frozen v1 fixtures on hosts that never created the table).
    return {
      ok: false,
      code: 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID',
      message: `the discovery certificate ${ref} pinned by the case does not resolve `
        + `(the certificate table exists but row ${certificateId} is missing) — the `
        + 'gate never diffs against a register authority it cannot verify',
    };
  }
  if (
    typeof row.certificate_hash !== 'string'
    || row.certificate_hash !== formalizationCase.discoveryCertificateHash
  ) {
    return {
      ok: false,
      code: 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID',
      message: `the discovery certificate ${ref} hashes '${String(row.certificate_hash)}' `
        + `but the case pins '${formalizationCase.discoveryCertificateHash}' — the `
        + 'disposition gate never diffs against an unverified register authority',
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.certificate_payload));
  } catch {
    return {
      ok: false,
      code: 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID',
      message: `the discovery certificate ${ref} payload is not parseable JSON`,
    };
  }
  try {
    return {
      ok: true,
      authority: resolveFormalizationCaseRegisterAuthority(formalizationCase, payload),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Resolve the coverage requirement for a task. Returns null when the case
 * carries no register (retro-compat: empty diff, gate stays green).
 *
 * ADR-090 (CC-IC-2): the register is resolved CERTIFICATE-FIRST through the
 * same shared authority as the A1 disposition gate
 * (`resolveRegisterAuthorityForCoverage`) — a v2 corpus (unknowns lifted to
 * open-question entries + declared lifecycle injections) can never silently
 * lose its coverage gates to the legacy v1 proposal-payload rebuild, and a
 * certificate/case divergence is a typed red, never a silent skip.
 *
 * Waivers follow the per-schema-version rule
 * (`waivedConstraintIdsForRegister`): v1 keeps the frozen legacy
 * waived+non-empty-reason rule; a v2 register NEVER subtracts — the v2
 * waiver state is typed unavailable (the 2026-08-23 waiver-authority
 * decision), so `resolved` and `deferred` are disposition states, never
 * coverage discharges.
 */
export function readConstraintCoverageRequirement(
  db: DbHandle,
  taskId: number,
  processRunId: number,
): (ConstraintCoverageRequirement & { registerTexts: Readonly<Record<string, string>> }) | null {
  const taskRow = db.prepare(
    'SELECT metadata FROM tasks WHERE id=?',
  ).get(taskId) as { metadata: string | null } | undefined;
  if (!taskRow || typeof taskRow.metadata !== 'string') return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(taskRow.metadata);
  } catch {
    return null;
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const caseCandidate = (metadata as Record<string, unknown>).process_node_input;
  if (
    typeof caseCandidate !== 'object'
    || caseCandidate === null
    || Array.isArray(caseCandidate)
    || (caseCandidate as Record<string, unknown>).schemaVersion !== FORMALIZATION_CASE_SCHEMA
  ) {
    return null;
  }
  const formalizationCase = caseCandidate as unknown as FormalizationCase;
  const authority = resolveRegisterAuthorityForCoverage(db, formalizationCase);
  if (!authority.ok) {
    // Certificate/case divergence: fail closed with the typed reason — the
    // coverage gates never silently skip on an unverified authority.
    throw new Error(`${authority.code}: ${authority.message}`);
  }
  const binding = authority.authority?.binding ?? null;
  if (!binding) return null;

  const briefRow = db.prepare(
    `SELECT a.metadata
       FROM artifacts a
       JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
      WHERE p.process_run_id=? AND a.type='brief'
      ORDER BY a.id DESC LIMIT 1`,
  ).get(processRunId) as { metadata: string | null } | undefined;
  let dispositions: Readonly<Record<string, unknown>> | null = null;
  if (briefRow && typeof briefRow.metadata === 'string') {
    try {
      const parsed = JSON.parse(briefRow.metadata) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const carried = (parsed as Record<string, unknown>).constraint_dispositions;
        if (typeof carried === 'object' && carried !== null && !Array.isArray(carried)) {
          dispositions = carried as Record<string, unknown>;
        }
      }
    } catch {
      // Unreadable brief metadata: no waivers count. The A1 gate owns the
      // disposition-validity defect; here it just means nothing is waived.
    }
  }
  const waivedIds = waivedConstraintIdsForRegister(
    binding.constraintRegister,
    dispositions,
  );

  const registerTexts: Record<string, string> = {};
  for (const entry of binding.constraintRegister.constraints) {
    registerTexts[entry.id] = `${entry.class}: ${entry.text}`;
  }
  return {
    constraintIds: binding.constraintRegister.constraints.map(entry => entry.id),
    waivedIds,
    registerTexts,
  };
}

/**
 * Build the structured per-ID SubmissionGaps for uncovered constraints. The
 * relation is `covers_constraint` — the same typed relation the A1
 * disposition gate uses, so repair feedback names the ID either way.
 */
export function constraintCoverageSubmissionGaps(
  uncoveredIds: readonly string[],
  registerTexts: Readonly<Record<string, string>>,
): ReadonlyArray<{
  artifactId: number;
  artifactCode: string;
  artifactType: string;
  existingTargets: ReadonlyArray<{ type: string; id: number }>;
  missing: {
    relation: string;
    requiredTargetTypes: ReadonlyArray<string>;
    minimum: number;
  };
  message: string;
}> {
  return uncoveredIds.map(id => ({
    artifactId: -1,
    artifactCode: id,
    artifactType: 'AC',
    existingTargets: [],
    missing: {
      relation: 'covers_constraint',
      requiredTargetTypes: [id],
      minimum: 1,
    },
    message: `Constraint ${id} (${registerTexts[id] ?? 'order constraint'}) is covered by no AC:`
      + ` add it to an AC artifact's metadata covered_constraint_ids`
      + ` (or waive it in the brief with a reason).`,
  }));
}
