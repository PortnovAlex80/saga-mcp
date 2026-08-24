/**
 * CC-GAP-7 (CONFORMANCE-CLOSURE-PLAN / CC-00C) — verification-warrant oracle
 * adapters: the package/workshop-declared oracle contract the local-
 * runnability readiness provider consumes READ-ONLY when the readiness
 * manifest carries a present `VerificationWarrantRef`.
 *
 * Bounded scope of this landing (CC-GAP-7A):
 *   - the adapter contract is DATA declared on the readiness manifest
 *     (`warrantOracles` — LEGO principle, Conveyor Mental Model §3;
 *     no-workshop-branch rule — master plan §4). Deliverable specifics
 *     (browser/canvas/…) arrive ONLY through the declared data, never
 *     through engine or test-engine branches on product type, workshop
 *     name, `moduleRef`, or role profession;
 *   - warrant execution NEVER re-reads the order prose: the register and
 *     the dispositions are the frozen, digest-pinned warrant content
 *     (AC-drift network 3), cross-bound to the exact discovery
 *     certificate, FormalizationCase, and the case's inherited constraint
 *     register coverage;
 *   - the three outcome classes stay mechanically distinct (ADR-089 §1):
 *     product-failed (a check exercised the product and the product
 *     failed), oracle-insufficient (the declared oracle set cannot prove
 *     the claim — an outstanding obligation, never a pass and never a
 *     product verdict), substrate-unavailable (a missing environment
 *     precondition, ADR-089/091). A missing adapter, an unsupported claim,
 *     or transport-only evidence that cannot prove a claim yields the
 *     typed `warrant-oracle-insufficient` UNKNOWN outcome;
 *   - receipt-binding duty (ADR-083 §6 split): warrant execution CONSUMES
 *     and receipt-binds the derived `environmentDigest`; it never issues,
 *     blesses, or substitutes an environment identity. The adapter never
 *     authorizes environment identity — the warrant observation records
 *     the digest the check ran under, produced only by the K19 derivation
 *     and the executor's observed image identity, never by adapter data.
 *
 * Not implemented here (bounded out): the CC-U2 semantic served-surface
 * analysis. The generic served phases (start + loopback HTTP probe + stop)
 * remain TRANSPORT-ONLY evidence — they are never adapter coverage; a
 * register claim proved only by them is oracle-insufficient.
 */

import type { SqlDatabasePort } from '../../application/ports/sql-database.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  verifyOrderConstraintRegister,
  type OrderConstraintRegister,
} from '../../shared/constraint-register.js';
import {
  resolveDevelopmentConstraintRegisterCoverage,
  resolveExpectedWarrantCrossBind,
  validateWarrantOracleDeclarations,
  type DevelopmentCase,
  type VerificationWarrantRef,
  type WarrantOracleAdapterDeclaration,
} from '../../modules/development/domain/development-schemas.js';

/**
 * The typed oracle-insufficient diagnostic (CC-GAP-7 network-3 vocabulary,
 * the mirror of ADR-089's `warrant-blocked-environment` for the
 * oracle-insufficiency class). Exact string stability is frozen by the
 * CC-GAP-7 blocking proofs. Rides an `unknown` receipt — never `passed`,
 * never `failed`.
 */
export const WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC = 'warrant-oracle-insufficient';

/** The default bounded timeout for one adapter evidence command. */
export const WARRANT_ORACLE_EVIDENCE_TIMEOUT_MS = 300_000;

/**
 * The A1 waiver rule shared by every consumer of the brief's constraint
 * dispositions (structural mirror of
 * `waivedConstraintIdsFromDispositions` in
 * src/modules/formalization/domain/formalization-schemas.ts — never
 * imported across workshop trees; same discipline as
 * VerificationWarrantRef): a waiver counts ONLY with disposition='waived'
 * AND a non-empty reason. Anything else is a reaction defect the A1 gate
 * owns — never a coverage free pass.
 */
export function waivedConstraintIdsFromWarrantDispositions(
  dispositions: Readonly<Record<string, unknown>>,
): string[] {
  const waivedIds: string[] = [];
  for (const [id, value] of Object.entries(dispositions)) {
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).disposition === 'waived'
      && typeof (value as Record<string, unknown>).reason === 'string'
      && ((value as Record<string, unknown>).reason as string).trim().length > 0
    ) {
      waivedIds.push(id);
    }
  }
  return waivedIds;
}

/**
 * Parse the raw manifest oracle declarations into the closed typed shape.
 * Fail-closed (the submission contract validated the same shape; this is
 * the independent provider-side re-validation — defense in depth): any
 * malformed declaration is a typed identity failure, never silently
 * dropped and never guessed.
 */
export function parseWarrantOracleDeclarations(
  raw: unknown,
): { status: 'ok'; declarations: readonly WarrantOracleAdapterDeclaration[] } | { status: 'invalid'; reason: string } {
  if (raw === undefined || raw === null) return { status: 'ok', declarations: [] };
  const structuralErrors = validateWarrantOracleDeclarations(true, raw);
  if (structuralErrors.length > 0) {
    return {
      status: 'invalid',
      reason: 'WARRANT_ORACLE_DECLARATIONS_INVALID: ' + structuralErrors.join('; '),
    };
  }
  if (!Array.isArray(raw)) {
    return {
      status: 'invalid',
      reason: 'WARRANT_ORACLE_DECLARATIONS_INVALID: warrantOracles must be an array of oracle adapter declarations',
    };
  }
  const declarations: WarrantOracleAdapterDeclaration[] = [];
  const seenAdapterIds = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        status: 'invalid',
        reason: `WARRANT_ORACLE_DECLARATION_INVALID: warrantOracles[${index}] must be an object`,
      };
    }
    const record = entry as Record<string, unknown>;
    const adapterId = record['adapterId'];
    const adapterVersion = record['adapterVersion'];
    const covers = record['coversConstraintIds'];
    const evidenceCommand = record['evidenceCommand'];
    if (typeof adapterId !== 'string' || adapterId.trim().length === 0
        || typeof adapterVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(adapterVersion)) {
      return {
        status: 'invalid',
        reason: `WARRANT_ORACLE_DECLARATION_INVALID: warrantOracles[${index}] requires a non-empty adapterId and a semver adapterVersion`,
      };
    }
    if (seenAdapterIds.has(adapterId)) {
      return {
        status: 'invalid',
        reason: `WARRANT_ORACLE_DECLARATION_INVALID: adapter identity '${adapterId}' is declared twice — adapter identity is unique within the manifest`,
      };
    }
    seenAdapterIds.add(adapterId);
    if (!Array.isArray(covers) || covers.length === 0
        || covers.some(id => typeof id !== 'string' || id.trim().length === 0)) {
      return {
        status: 'invalid',
        reason: `WARRANT_ORACLE_DECLARATION_INVALID: warrantOracles[${index}].coversConstraintIds must be a non-empty array of register constraint ids`,
      };
    }
    if (typeof evidenceCommand !== 'string' || evidenceCommand.trim().length === 0) {
      return {
        status: 'invalid',
        reason: `WARRANT_ORACLE_DECLARATION_INVALID: warrantOracles[${index}].evidenceCommand must be a non-empty string`,
      };
    }
    declarations.push({
      adapterId,
      adapterVersion,
      coversConstraintIds: Object.freeze([...covers as unknown[]] as string[]),
      evidenceCommand,
    });
  }
  return { status: 'ok', declarations };
}

/** The authority resolution outcome of a present warrant. */
export type WarrantOracleAuthority =
  | {
    readonly status: 'verified';
    /** The register read from the exact cross-bound discovery certificate. */
    readonly register: OrderConstraintRegister;
    /** The typed waiver set (A1 rule over the warrant's digest-pinned dispositions). */
    readonly waivedIds: readonly string[];
  }
  | {
    readonly status: 'invalid';
    /** A typed product-failure code (identity integrity — the m7 consumer discipline). */
    readonly code: string;
    readonly reason: string;
  };

/**
 * Resolve + cross-bind a present warrant's authority, DB-only:
 *
 *   1. SELF-CONSISTENCY — the warrant's register ref is the content-
 *      addressed pairing of its digest, and the dispositions digest is the
 *      sha256 of the dispositions it carries (register+dispositions
 *      self-consistency alone is not identity — the cross-binds below are);
 *   2. CASE → WARRANT — the subject process run's frozen input (the
 *      DevelopmentCase) carries the AUTHORITATIVE expected cross-bind
 *      identities (`resolveExpectedWarrantCrossBind` — same source the
 *      settlement bind boundary uses) and the warrant must match them
 *      exactly; resolved FIRST so a deviating warrant is a typed RETARGET,
 *      never misread as an absent authority row;
 *   3. CERTIFICATE → REGISTER — the discovery certificate named by
 *      `discoveryCertificateHash` (now case-verified) is read by exact
 *      content-addressed hash (globally unique, write-once) and the
 *      register it froze verifies (`verifyOrderConstraintRegister`) with
 *      `registerDigest` equal to the warrant's `constraintRegisterDigest`;
 *   4. CASE → REGISTER — when the case carries the inherited
 *      `constraintRegisterCoverage` block (ADR-088 relay), its register
 *      digest must equal the warrant's register digest: the warrant
 *      executes the register THIS case inherited, never a substituted one.
 *
 * Any violation is a typed identity failure (product `failed` — the same
 * discipline as the m7 consumer boundary at bind), never a silent
 * unverifiable accept and never oracle-insufficient: identity integrity
 * and oracle sufficiency are different questions.
 */
export function resolveWarrantOracleAuthority(input: {
  readonly db: SqlDatabasePort;
  readonly processRunId: number;
  readonly warrant: VerificationWarrantRef;
}): WarrantOracleAuthority {
  const { db, processRunId, warrant } = input;
  // (1) self-consistency
  if (warrant.constraintRegisterRef !== `constraint-register:${warrant.constraintRegisterDigest}`) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_IDENTITY_INVALID',
      reason: 'WARRANT_ORACLE_IDENTITY_INVALID: the warrant constraintRegisterRef does not pair with its constraintRegisterDigest (constraint-register:<digest>)',
    };
  }
  if (sha256Hex(warrant.dispositions) !== warrant.dispositionsDigest) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_IDENTITY_INVALID',
      reason: 'WARRANT_ORACLE_IDENTITY_INVALID: the warrant dispositionsDigest is not the sha256 of the dispositions it carries',
    };
  }
  // (2) case → warrant (the authoritative expected cross-bind). Resolved
  // BEFORE the certificate load: a warrant whose certificate/case identity
  // deviates from the case's expectation is a RETARGET (typed mismatch),
  // never misclassified as an absent authority row.
  let runInput: unknown;
  try {
    const row = db.prepare(
      'SELECT input_snapshot FROM factory_process_runs WHERE id=?',
    ).get(processRunId) as { input_snapshot: string } | undefined;
    if (!row) {
      return {
        status: 'invalid',
        code: 'WARRANT_ORACLE_CASE_UNAVAILABLE',
        reason: `WARRANT_ORACLE_CASE_UNAVAILABLE: the subject process run ${processRunId} has no frozen input to resolve the DevelopmentCase the warrant must cross-bind against`,
      };
    }
    runInput = JSON.parse(row.input_snapshot);
  } catch (error) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_CASE_UNAVAILABLE',
      reason: 'WARRANT_ORACLE_CASE_UNAVAILABLE: the subject process run input could not be read: '
        + (error instanceof Error ? error.message : String(error)),
    };
  }
  // Structural case view: both resolvers read only solutionContractPayload.
  const developmentCase = (runInput && typeof runInput === 'object'
    ? runInput
    : {}) as DevelopmentCase;
  const expected = resolveExpectedWarrantCrossBind(developmentCase);
  if (!expected) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_CASE_EXPECTATION_MISSING',
      reason: 'WARRANT_ORACLE_CASE_EXPECTATION_MISSING: the subject run\'s DevelopmentCase carries no authoritative warrant cross-bind expectation (discoveryCertificateHash/formalizationCaseDigest on the frozen solution-contract payload) — a present warrant is never silently accepted unverifiable',
    };
  }
  const warrantCertificateHash = warrant.discoveryCertificateHash;
  const warrantCaseDigest = warrant.formalizationCaseDigest;
  if (warrantCertificateHash === undefined || warrantCaseDigest === undefined
      || warrantCertificateHash !== expected.discoveryCertificateHash
      || warrantCaseDigest !== expected.formalizationCaseDigest) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_CROSS_BIND_MISMATCH',
      reason: `WARRANT_ORACLE_CROSS_BIND_MISMATCH: the warrant cross-bind does not match the authoritative certificate/case identities of this DevelopmentCase (warrant certificate ${warrantCertificateHash !== undefined ? warrantCertificateHash.slice(0, 16) : '<absent>'}… / case ${warrantCaseDigest !== undefined ? warrantCaseDigest.slice(0, 16) : '<absent>'}…)`,
    };
  }
  // (3) certificate → register
  const certificateHash = warrantCertificateHash;
  let certificatePayload: unknown;
  try {
    const row = db.prepare(
      'SELECT certificate_payload FROM factory_process_outcome_certificates WHERE certificate_hash=?',
    ).get(certificateHash) as { certificate_payload: string } | undefined;
    if (!row) {
      return {
        status: 'invalid',
        code: 'WARRANT_ORACLE_CERTIFICATE_MISSING',
        reason: `WARRANT_ORACLE_CERTIFICATE_MISSING: no outcome certificate exists for the warrant's discoveryCertificateHash ${certificateHash.slice(0, 16)}… — the warrant names an authority this factory never issued`,
      };
    }
    certificatePayload = JSON.parse(row.certificate_payload);
  } catch (error) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_CERTIFICATE_MISSING',
      reason: 'WARRANT_ORACLE_CERTIFICATE_MISSING: the certificate substrate could not be read for the warrant\'s discoveryCertificateHash: '
        + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (!certificatePayload || typeof certificatePayload !== 'object') {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_REGISTER_UNAVAILABLE',
      reason: 'WARRANT_ORACLE_REGISTER_UNAVAILABLE: the cross-bound discovery certificate payload is malformed',
    };
  }
  const frozenRegister = (certificatePayload as Record<string, unknown>)['constraintRegister'];
  if (frozenRegister === undefined || frozenRegister === null) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_REGISTER_UNAVAILABLE',
      reason: 'WARRANT_ORACLE_REGISTER_UNAVAILABLE: the cross-bound discovery certificate froze no constraint register — a warrant cannot execute against it',
    };
  }
  let register: OrderConstraintRegister | null;
  try {
    register = verifyOrderConstraintRegister(frozenRegister);
  } catch (error) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_REGISTER_TAMPERED',
      reason: 'WARRANT_ORACLE_REGISTER_TAMPERED: the certificate register failed verification: '
        + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (register === null) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_REGISTER_UNAVAILABLE',
      reason: 'WARRANT_ORACLE_REGISTER_UNAVAILABLE: the certificate register value carries no register content',
    };
  }
  if (register.registerDigest !== warrant.constraintRegisterDigest) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_REGISTER_MISMATCH',
      reason: 'WARRANT_ORACLE_REGISTER_MISMATCH: the register frozen on the cross-bound certificate has a different digest than the warrant names — a re-targeted warrant is a typed red',
    };
  }
  // (4) case → register (the inherited coverage relay)
  try {
    const coverage = resolveDevelopmentConstraintRegisterCoverage(developmentCase);
    if (coverage !== null && coverage.constraintRegisterDigest !== warrant.constraintRegisterDigest) {
      return {
        status: 'invalid',
        code: 'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH',
        reason: 'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH: the warrant register digest differs from the constraint register this case inherited through the solution contract — the warrant must execute the inherited register, never a substituted one',
      };
    }
    if (coverage !== null) {
      const warrantWaivedIds = [...new Set(
        waivedConstraintIdsFromWarrantDispositions(warrant.dispositions),
      )].sort();
      const expectedWaivedIds = [...new Set(coverage.waivedIds)].sort();
      if (warrantWaivedIds.length !== expectedWaivedIds.length
          || warrantWaivedIds.some((id, index) => id !== expectedWaivedIds[index])) {
        return {
          status: 'invalid',
          code: 'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH',
          reason: 'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH: the warrant waiver set differs from the frozen constraintRegisterCoverage this case inherited through the solution contract; a self-consistent dispositions digest cannot authorize a new waiver',
        };
      }
    }
  } catch (error) {
    return {
      status: 'invalid',
      code: 'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH',
      reason: 'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH: the case\'s constraintRegisterCoverage block is malformed: '
        + (error instanceof Error ? error.message : String(error)),
    };
  }
  return {
    status: 'verified',
    register,
    waivedIds: Object.freeze(
      [...new Set(waivedConstraintIdsFromWarrantDispositions(warrant.dispositions))].sort(),
    ),
  };
}

/** One adapter resolved against the register: what it lawfully proves here. */
export interface ResolvedWarrantOracleAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly evidenceCommand: string;
  /** The register ids this adapter was DECLARED to cover (verbatim, sorted). */
  readonly coversConstraintIds: readonly string[];
}

/** The executable warrant plan: every non-waived execution-class register entry has a declared adapter. */
export interface ExecutableWarrantOraclePlan {
  readonly status: 'executable';
  /** Adapters to execute, deterministic order (sorted by adapterId). */
  readonly adapters: readonly ResolvedWarrantOracleAdapter[];
  /** The non-waived execution-class register ids the plan proves (sorted). */
  readonly executionClassIds: readonly string[];
  /** The typed waiver set (A1 rule over the warrant's dispositions). */
  readonly waivedIds: readonly string[];
}

/** The oracle-insufficient plan: the declared oracle set cannot prove the warrant. */
export interface OracleInsufficientWarrantPlan {
  readonly status: 'oracle-insufficient';
  /** Non-waived execution-class register ids NO declared adapter covers. */
  readonly uncoveredIds: readonly string[];
  /** Adapter-declared ids that name no constraint in the register (unsupported claims). */
  readonly unsupportedIds: readonly string[];
  /** The adapters that WERE declared (identity evidence for the receipt). */
  readonly declaredAdapters: readonly { readonly adapterId: string; readonly adapterVersion: string }[];
  readonly waivedIds: readonly string[];
}

export type WarrantOraclePlan = ExecutableWarrantOraclePlan | OracleInsufficientWarrantPlan;

/**
 * Plan warrant execution over the VERIFIED authority: diff the register's
 * non-waived EXECUTION-class entries (the register's own closed vocabulary
 * — "a runnable check the order text commands"; no prose rereading, no
 * product-type switch) against the union of the declared adapters'
 * coverage.
 *
 *   - a non-waived execution-class id covered by no adapter → UNCOVERED;
 *   - an adapter id naming no register constraint → UNSUPPORTED (the
 *     declared oracle set misstates what it covers — never silently
 *     ignored, never a pass);
 *   - either set non-empty → oracle-insufficient (the typed unknown);
 *   - both empty → executable: the listed adapters run their evidence
 *     commands in the prepared environment.
 *
 * The generic served phases (start + loopback HTTP probe + stop) are
 * TRANSPORT-ONLY evidence and are never adapter coverage: a browser-product
 * claim proved only by loopback health lands in `uncoveredIds` — never a
 * pass and never a product-failed verdict.
 */
export function planWarrantOracleExecution(input: {
  readonly register: OrderConstraintRegister;
  readonly declarations: readonly WarrantOracleAdapterDeclaration[];
  readonly waivedIds: readonly string[];
}): WarrantOraclePlan {
  const { register, declarations, waivedIds } = input;
  const registerIds = new Set(register.constraints.map(entry => entry.id));
  const waived = new Set(waivedIds);
  const executionClassIds = register.constraints
    .filter(entry => entry.class === 'execution' && !waived.has(entry.id))
    .map(entry => entry.id)
    .sort();
  const covered = new Set<string>();
  const unsupported = new Set<string>();
  const declaredAdapters: Array<{ adapterId: string; adapterVersion: string }> = [];
  for (const declaration of [...declarations].sort((a, b) => a.adapterId.localeCompare(b.adapterId))) {
    declaredAdapters.push({
      adapterId: declaration.adapterId,
      adapterVersion: declaration.adapterVersion,
    });
    for (const id of declaration.coversConstraintIds) {
      if (!registerIds.has(id)) {
        unsupported.add(id);
      } else {
        covered.add(id);
      }
    }
  }
  const uncoveredIds = executionClassIds.filter(id => !covered.has(id));
  if (uncoveredIds.length > 0 || unsupported.size > 0) {
    return {
      status: 'oracle-insufficient',
      uncoveredIds: Object.freeze(uncoveredIds),
      unsupportedIds: Object.freeze([...unsupported].sort()),
      declaredAdapters: Object.freeze(declaredAdapters),
      waivedIds: Object.freeze([...waivedIds]),
    };
  }
  return {
    status: 'executable',
    adapters: Object.freeze(declarations
      .map(declaration => ({
        adapterId: declaration.adapterId,
        adapterVersion: declaration.adapterVersion,
        evidenceCommand: declaration.evidenceCommand,
        coversConstraintIds: Object.freeze([...declaration.coversConstraintIds].sort()),
      }))
      .sort((a, b) => a.adapterId.localeCompare(b.adapterId))),
    executionClassIds: Object.freeze(executionClassIds),
    waivedIds: Object.freeze([...waivedIds]),
  };
}

/**
 * CC-GAP-7 blocking mutation (missing environment binding) — the guard that
 * keeps a warrant receipt honest: every warrant-bearing receipt observation
 * MUST carry the derived `environmentDigest` it ran under (ADR-083 §6:
 * warrant execution consumes and receipt-binds; it never authorizes). A
 * warrant observation without the digest is a typed red, never a receipt.
 */
export function assertWarrantReceiptBindsEnvironment(
  observation: Record<string, unknown>,
): void {
  const warrant = observation['warrant'];
  const digest = warrant && typeof warrant === 'object' && !Array.isArray(warrant)
    ? (warrant as Record<string, unknown>)['environmentDigest']
    : undefined;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(
      'WARRANT_ORACLE_ENVIRONMENT_BINDING_MISSING: a warrant receipt observation must bind the derived environmentDigest it ran under (64-hex) — the adapter never authorizes environment identity, and the receipt never omits it',
    );
  }
}

/**
 * Build the receipt-binding warrant observation for an EXECUTED (passed)
 * warrant: the warrant identity (register + dispositions digests), the
 * executed adapter identities/versions, the proved execution-class ids, the
 * typed waiver set, and the CONSUMED derived environmentDigest (asserted
 * present by the guard above). The provider digest and the exact candidate
 * identities bind the same receipt through the enclosing digest input —
 * candidate/provider digest + warrant + environment in one identity
 * (ADR-083 §2.6).
 */
export function warrantReceiptObservation(input: {
  readonly warrant: VerificationWarrantRef;
  readonly plan: ExecutableWarrantOraclePlan;
  readonly environmentDigest: string;
}): Record<string, unknown> {
  const observation = {
    warrant: {
      constraintRegisterDigest: input.warrant.constraintRegisterDigest,
      dispositionsDigest: input.warrant.dispositionsDigest,
      provedExecutionConstraintIds: [...input.plan.executionClassIds],
      waivedConstraintIds: [...input.plan.waivedIds],
      adapters: input.plan.adapters.map(adapter => ({
        adapterId: adapter.adapterId,
        adapterVersion: adapter.adapterVersion,
        coversConstraintIds: [...adapter.coversConstraintIds],
      })),
      environmentDigest: input.environmentDigest,
    },
  };
  assertWarrantReceiptBindsEnvironment(observation);
  return observation;
}

/**
 * Build the observation for the typed oracle-insufficient UNKNOWN receipt:
 * the warrant identity, the named uncovered/unsupported ids, the declared
 * adapter identities, the typed waiver set, and the derived
 * environmentDigest the check WOULD have certified under (the same honest
 * statement the ADR-089 unknown receipt makes about the environment).
 */
export function warrantOracleInsufficientObservation(input: {
  readonly warrant: VerificationWarrantRef;
  readonly plan: OracleInsufficientWarrantPlan;
  readonly environmentDigest: string;
}): Record<string, unknown> {
  const observation = {
    warrant: {
      constraintRegisterDigest: input.warrant.constraintRegisterDigest,
      dispositionsDigest: input.warrant.dispositionsDigest,
      uncoveredConstraintIds: [...input.plan.uncoveredIds],
      unsupportedConstraintIds: [...input.plan.unsupportedIds],
      declaredAdapters: input.plan.declaredAdapters.map(adapter => ({
        adapterId: adapter.adapterId,
        adapterVersion: adapter.adapterVersion,
      })),
      waivedConstraintIds: [...input.plan.waivedIds],
      environmentDigest: input.environmentDigest,
    },
  };
  assertWarrantReceiptBindsEnvironment(observation);
  return observation;
}

/** Human-readable summary stamped into the oracle-insufficient diagnostic. */
export function warrantOracleInsufficientMessage(
  plan: OracleInsufficientWarrantPlan,
): string {
  const parts: string[] = [];
  if (plan.uncoveredIds.length > 0) {
    parts.push(
      'no declared oracle adapter covers the non-waived execution-class register constraint(s) '
      + plan.uncoveredIds.join(', '),
    );
  }
  if (plan.unsupportedIds.length > 0) {
    parts.push(
      'the declared adapter set claims constraint id(s) absent from the warrant register: '
      + plan.unsupportedIds.join(', '),
    );
  }
  const declared = plan.declaredAdapters.length > 0
    ? plan.declaredAdapters.map(adapter => `${adapter.adapterId}@${adapter.adapterVersion}`).join(', ')
    : 'NONE — the manifest declares no oracle adapters';
  return 'the declared oracle set cannot prove the warrant: ' + parts.join('; ') + '. '
    + 'Declared adapters: ' + declared + '. '
    + 'The generic served phases (start + loopback HTTP probe + stop) are transport-only evidence and '
    + 'are never adapter coverage — the claim is neither passed nor product-failed; it stays an '
    + 'outstanding obligation. Declare a package-level oracle adapter that proves the claim (running '
    + 'its deterministic evidence command in the prepared environment), or obtain an '
    + 'operator-attributed waiver (CC-GAP-8 discharge rule).';
}
