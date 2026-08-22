import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CandidateSetReaderPort } from '../../application/ports/candidate-set-reader.js';
import type { CandidateSet } from '../../process-modules/domain/workplace/candidate-set.js';
import type { SqlDatabasePort } from '../../application/ports/sql-database.js';
import type {
  CheckProvider,
  CheckProviderResult,
} from '../../process-modules/domain/workplace/gate.js';
import { encodeCheckDiagnostic } from '../../process-modules/domain/workplace/check-diagnostic.js';
import {
  encodeSeamRepairIssue,
  type SeamKind,
  type SeamRepairIssue,
} from '../../process-modules/domain/workplace/seam-repair-issue.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import { repositoryScopeCovers } from '../../shared/repository-scope.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../modules/development/application/candidate-check-contracts.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../modules/development/domain/development-schemas.js';
import type { ReadinessProfile, RunnabilityCommands } from '../../modules/development/domain/development-schemas.js';
import {
  isTestFilePath,
  normalizeTestPath,
  resolveDeclaredTestSurface,
  withTestFilesExtendedTo,
} from '../../modules/development/domain/readiness-test-surface.js';
import {
  runServedProcess,
  type CommandTarget,
} from './served-process-runner.js';
import {
  commandFailureDetail,
  type ExecutorDescription,
  type ReadinessExecutor,
  type ServeEvidence,
  ReadinessExecutionError,
} from './readiness-executor.js';
import {
  DockerReadinessExecutor,
  resetDockerAvailabilityCache,
} from './docker-readiness-executor.js';
import {
  runBoundedSubstrateRetry,
  substrateRetryMessage,
  substrateRetryObservation,
  SUBSTRATE_PRECONDITION_DIAGNOSTIC,
  type SubstrateRetryAttempt,
} from './substrate-retry.js';
import {
  augmentInstallCommand,
  deriveExecutionEnvironment,
} from './environment-derivation.js';
import {
  CliComposeRunner,
  composeModeFromEnvironment,
  DEFAULT_COMPOSE_UP_TIMEOUT_MS,
  type ComposeDeclaration,
  type ComposeRunner,
  validateComposeDeclaration,
} from './compose-readiness.js';

export {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../modules/development/application/candidate-check-contracts.js';

interface CandidateSubject {
  repositoryPath: string;
  commitSha: string;
  treeHash: string;
  candidateHash: string;
  /**
   * The process run whose task graph scopes resolve seam repair-issue owners
   * (SEAM-ARCHITECT Layer 2: the scope provider determines the owning task by
   * path). Never a material authority — routing metadata only.
   */
  processRunId: number;
  /**
   * The explicit readiness profile stated by the accepted product (parsed but
   * NOT yet validated). Validation + the fail-closed policy live in
   * runLocalReadiness so an absent/invalid profile yields a 'failed' readiness
   * outcome, not the 'error' sentinel reserved for subject-resolution failures.
   */
  readiness: unknown;
}

/**
 * A full git object id (SHA-1, 40 hex). The runnability authority must be a
 * content-addressed object id — NEVER a moving ref, branch name, tip, HEAD, or
 * a working-tree path. ADR-053 / LR-02.
 */
const OBJECT_ID_RE = /^[a-f0-9]{40}$/u;

/**
 * Factory-owned local readiness check. It deliberately proves only that the
 * exact frozen candidate passes its required test command and can be started,
 * probed on loopback, and stopped. It is not semantic AC authority (ADR-058).
 */
export function createLocalRunnabilityCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
  /**
   * SEAM-ARCHITECT Layer 2 (a) — the compose substrate, injectable so the
   * compose probe mechanics are hermetically testable (fakes; no docker in
   * CI). Defaults to the CLI runner.
   */
  composeRunner?: ComposeRunner;
  /**
   * CC-GAP-9 / ADR-089 test seam — hermetic control over WHERE the readiness
   * commands run, so the bounded substrate retry is provable without a real
   * docker daemon. Defaults to the production selector (host / docker by
   * profile + SAGA_LOCAL_RUNNABILITY_EXEC). The retry POLICY (bound +
   * schedule) is NOT injectable — it is frozen in substrate-retry.ts.
   */
  executorSelector?: (
    directory: string,
    profile: ReadinessProfile,
  ) => ReadinessExecutor;
  /**
   * CC-GAP-9 / ADR-089 test seam — instant sleep for the frozen substrate
   * retry schedule so exhausted-retry proofs stay hermetic and fast. Only
   * the sleep FUNCTION is injectable; the schedule VALUE is frozen.
   */
  substrateRetrySleep?: (ms: number) => void;
}): CheckProvider {
  const composeRunner = input.composeRunner ?? new CliComposeRunner();
  const substrateOptions = {
    selectExecutor: input.executorSelector ?? selectReadinessExecutor,
    ...(input.substrateRetrySleep
      ? { sleep: input.substrateRetrySleep }
      : {}),
  };
  return {
    providerId: LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
    version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      // LR-06 — DURABLE REPLAY. The readiness outcome + proof are persisted in
      // factory_check_receipts (the Gate-receipt substrate is the ONE durable
      // acceptance-authority store, per ADR-053). On any re-query for the same
      // subject + provider — whether a GateRun replay, a new GateRun for the
      // same sealed subject, or a direct provider call after a process restart
      // — the persisted receipt is returned verbatim. The provider is NOT
      // re-invoked and the process is NOT re-spawned. This replaces the
      // previous non-durable in-memory Map, which was lost on restart and was a
      // second (competing) replay authority that overlapped with the durable
      // Gate receipts. The provider only READS receipts; the GateRun driver
      // WRITES them — there is no second store.
      //
      // D1 — the replay is keyed by the candidate BYTES (see
      // resolveSubjectBindingRef), not by the manifest's candidate-set ref:
      // every repair round seals a NEW manifest (new content = new ref), and a
      // ref-only key let a rewritten declaration manufacture a "new subject"
      // out of unchanged bytes. DB-only resolution (no git) so a replay works
      // even when the repository checkout is gone.
      const subjectBindingRef = resolveSubjectBindingRef(input, subjectCandidateSetRef);
      const replayed = readPersistedReadinessReceipt(
        input.db, subjectCandidateSetRef, subjectBindingRef,
      );
      if (replayed) return replayed;
      let subject;
      try {
        subject = resolveSubject(input, subjectCandidateSetRef, parameters);
      } catch (subjErr) {
        const reason = subjErr instanceof Error ? subjErr.message : String(subjErr);
        return {
          outcome: 'error',
          evidenceRefs: [encodeCheckDiagnostic({
            code: 'local-runnability-subject-error',
            message: 'subject resolution threw: ' + reason.slice(0, 900),
          })],
        };
      }
      let check: CheckProviderResult;
      try {
        check = runLocalReadiness(
          input.db, subject, subjectCandidateSetRef, composeRunner, substrateOptions,
        );
      } catch (diagErr) {
        const err = diagErr as { message?: unknown; stack?: unknown };
        const reason = (err.message !== undefined ? String(err.message) : String(diagErr))
          + (err.stack !== undefined ? ' | stack: ' + String(err.stack).slice(0, 600) : '');
        check = {
          outcome: 'error',
          evidenceRefs: [encodeCheckDiagnostic({
            code: 'local-runnability-execution-error',
            message: 'execution threw: ' + reason.slice(0, 1200),
          })],
        };
      }
      // D1 — bind the receipt to the candidate bytes it was produced against.
      // The binding rides every real (non-replayed) result so the next
      // round's persisted-receipt lookup can find it across manifest refs.
      // Appended LAST: existing evidence positions (proof ref, failure
      // diagnostic, seam issue, coverage report) are unchanged.
      return typeof check === 'string'
        ? { outcome: check, evidenceRefs: [subjectBindingRefOf(subject)] }
        : { outcome: check.outcome, evidenceRefs: [...check.evidenceRefs, subjectBindingRefOf(subject)] };
    },
  };
}

/** The D1 subject binding ref: local-readiness-subject:<hash>:<commit>:<tree>. */
function subjectBindingRefOf(subject: CandidateSubject): string {
  return `local-readiness-subject:${subject.candidateHash}:${subject.commitSha}:${subject.treeHash}`;
}

/**
 * D1 — resolve the candidate-bytes binding for a subject candidate-set ref,
 * DB-ONLY (candidate-set member → readiness manifest → sourceCandidate →
 * sealed product payload; or the integrated-candidate member directly). No
 * git access: a persisted receipt must replay even when the repository
 * checkout is gone. Returns null on any miss — the caller then falls back to
 * the legacy exact-ref receipt lookup and never fails because of this
 * pre-pass.
 */
function resolveSubjectBindingRef(
  input: { db: SqlDatabasePort; candidateSets: CandidateSetReaderPort },
  candidateSetRef: string,
): string | null {
  try {
    const set = input.candidateSets.read(candidateSetRef);
    if (!set || set.role !== 'author') return null;
    // Path 1 — the readiness-certification subject: a managed readiness
    // manifest member naming its exact integrated-source candidate.
    const manifestMember = set.members.find(candidate =>
      candidate.productRef.schemaId === DEVELOPMENT_READINESS_MANIFEST_SCHEMA
      && candidate.productRef.ref.startsWith('managed-node-submission:'));
    if (manifestMember) {
      const id = Number(
        manifestMember.productRef.ref.slice('managed-node-submission:'.length),
      );
      if (!Number.isSafeInteger(id)) return null;
      const row = input.db.prepare(
        `SELECT payload_snapshot FROM factory_managed_node_submissions
          WHERE id=? AND process_run_id=? AND schema_version=? AND content_hash=?`,
      ).get(
        id,
        set.workplaceRef.processRunId,
        DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
        manifestMember.productRef.digest,
      ) as { payload_snapshot: string } | undefined;
      if (!row) return null;
      const manifest = JSON.parse(row.payload_snapshot) as {
        sourceCandidate?: { schema?: unknown; ref?: unknown; hash?: unknown };
      };
      const source = manifest.sourceCandidate;
      if (source?.schema !== INTEGRATED_SOURCE_CANDIDATE_SCHEMA
          || typeof source.ref !== 'string' || typeof source.hash !== 'string'
          || !/^[a-f0-9]{64}$/u.test(source.hash)) {
        return null;
      }
      return bindingForProduct(
        input, set.workplaceRef.processRunId,
        INTEGRATED_SOURCE_CANDIDATE_SCHEMA, source.ref, source.hash,
      );
    }
    // Path 2 — the legacy subject shape: an integrated-candidate member.
    const member = set.members.find(
      candidate => candidate.productRef.schemaId === INTEGRATED_CANDIDATE_SCHEMA,
    );
    if (!member) return null;
    return bindingForProduct(
      input, set.workplaceRef.processRunId,
      INTEGRATED_CANDIDATE_SCHEMA, member.productRef.ref, member.productRef.digest,
    );
  } catch {
    return null;
  }
}

/** Read the sealed product's candidate identity and build the binding ref. */
function bindingForProduct(
  input: { db: SqlDatabasePort },
  processRunId: number,
  schemaId: string,
  artifactRef: string,
  productHash: string,
): string | null {
  try {
    const product = input.db.prepare(
      `SELECT payload_snapshot FROM factory_process_products
        WHERE process_run_id=? AND schema_id=? AND artifact_ref=? AND product_hash=?`,
    ).get(processRunId, schemaId, artifactRef, productHash) as
      { payload_snapshot: string } | undefined;
    if (!product) return null;
    const candidate = JSON.parse(product.payload_snapshot) as {
      candidateHash?: unknown;
      sourceHash?: unknown;
      repositories?: Array<{ commitSha?: unknown; treeHash?: unknown }>;
    };
    const candidateHash = typeof candidate.candidateHash === 'string'
      ? candidate.candidateHash
      : candidate.sourceHash;
    const repository = Array.isArray(candidate.repositories)
      ? candidate.repositories[0]
      : undefined;
    if (typeof candidateHash !== 'string'
        || !/^[a-f0-9]{64}$/u.test(candidateHash)
        || !repository
        || typeof repository.commitSha !== 'string'
        || !OBJECT_ID_RE.test(repository.commitSha)
        || typeof repository.treeHash !== 'string'
        || !OBJECT_ID_RE.test(repository.treeHash)) {
      return null;
    }
    return `local-readiness-subject:${candidateHash}:${repository.commitSha}:${repository.treeHash}`;
  } catch {
    return null;
  }
}

/**
 * LR-06 — read a persisted local-readiness receipt from the Gate-receipt
 * substrate (factory_check_receipts). Returns the persisted outcome + evidence
 * refs when a prior receipt exists for the exact subject_candidate_set_ref +
 * installed provider with a DEFINITIVE outcome (passed/failed), or null when no
 * receipt exists (first run), the table is absent (minimal test schema without
 * the Gate receipt substrate), or the only prior outcome was indeterminate
 * (error/unknown — those MUST be retried on every invocation, never replayed,
 * because they represent a subject-resolution or execution failure that may
 * have been transient).
 *
 * D1 — the lookup is ALSO keyed by the candidate BYTES: receipts whose
 * evidence carries the same subject binding (candidateHash + commitSha +
 * treeHash) participate in the replay/conflict decision EVEN WHEN they were
 * recorded under a different manifest's candidate-set ref. Effects:
 *   - a receipt for the same bytes replays across manifest rounds (a rewritten
 *     declaration cannot manufacture a "new subject" out of unchanged bytes —
 *     the round-4 gaming manifest hits the round-1 failed receipt);
 *   - same bytes + previously failed + now passed — with zero tracked-file
 *     diff, which the identical commit/tree in the binding PROVES — is a
 *     structurally impossible honest outcome and fails closed with the typed
 *     READINESS_RECEIPT_CANDIDATE_CONFLICT.
 * The exact-ref matches keep the legacy LR-06 semantics (replay of receipts
 * recorded for this exact ref, including pre-binding test-seeded rows); the
 * provider_digest filter ensures a swapped implementation (different digest)
 * does not replay a stale receipt.
 */
function readPersistedReadinessReceipt(
  db: SqlDatabasePort,
  subjectCandidateSetRef: string,
  subjectBindingRef: string | null,
): CheckProviderResult | null {
  let rows;
  try {
    rows = db.prepare(
      `SELECT outcome, evidence_refs, subject_candidate_set_ref
         FROM factory_check_receipts
        WHERE provider_id=?
          AND provider_digest=?
          AND outcome IN ('passed','failed')
          AND (subject_candidate_set_ref=?
               OR (? <> '' AND instr(evidence_refs, ?) > 0))
        ORDER BY check_receipt_ref`,
    ).all(
      LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
      subjectCandidateSetRef,
      subjectBindingRef ?? '',
      subjectBindingRef ?? '',
    ) as Array<{ outcome: string; evidence_refs: string; subject_candidate_set_ref: string }>;
  } catch {
    // The table is absent (e.g. a minimal in-memory test schema that did not
    // create the Gate receipt substrate). In production the table always exists
    // (schema.ts). Treat the missing table as "no persisted receipt" and
    // proceed to run the check.
    return null;
  }
  if (rows.length === 0) return null;
  // D1 — the impossible-outcome invariant over the receipts that are bound to
  // these exact bytes.
  if (subjectBindingRef !== null) {
    const bindingOutcomes = new Set(
      rows
        .filter(row => row.evidence_refs.includes(subjectBindingRef))
        .map(row => row.outcome),
    );
    if (bindingOutcomes.has('failed') && bindingOutcomes.has('passed')) {
      return {
        outcome: 'failed',
        evidenceRefs: [encodeCheckDiagnostic({
          code: 'READINESS_RECEIPT_CANDIDATE_CONFLICT',
          message: `Conflicting durable outcomes for the same source candidate bytes (subject binding ${subjectBindingRef}): `
            + 'a failed receipt and a passed receipt both bind these exact bytes. '
            + 'Same bytes + previously failed + now passed with zero tracked-file diff '
            + '(the identical commit and tree in the binding prove the zero diff) is a '
            + 'structurally impossible honest outcome — failing closed. Repair the '
            + 'failing cause in the candidate; do not rewrite the readiness declaration.',
        })],
      };
    }
  }
  const canonical = new Set(rows.map(row => JSON.stringify({
    outcome: row.outcome,
    evidenceRefs: JSON.parse(row.evidence_refs) as string[],
  })));
  if (canonical.size !== 1) {
    return {
      outcome: 'error',
      evidenceRefs: [encodeCheckDiagnostic({
        code: 'local-runnability-receipt-conflict',
        message: `Conflicting immutable readiness receipts exist for ${subjectCandidateSetRef}`,
      })],
    };
  }
  const row = rows[0]!;
  return {
    outcome: row.outcome as 'passed' | 'failed',
    evidenceRefs: JSON.parse(row.evidence_refs) as string[],
  };
}

export function ensureLocalRunnabilityProviderTrust(db: SqlDatabasePort): void {
  const existingRows = db.prepare(
    `SELECT version,category,trust_basis,determinism,scope,status
       FROM trusted_providers
      WHERE project_id IS NULL AND name=?`,
  ).all(LOCAL_RUNNABILITY_CHECK_PROVIDER_ID) as Array<{
    version: string | null;
    category: string;
    trust_basis: string;
    determinism: string;
    scope: string;
    status: string;
  }>;
  if (existingRows.length > 1) {
    throw new Error('LOCAL_RUNNABILITY_PROVIDER_TRUST_AMBIGUOUS');
  }
  const existing = existingRows[0];
  if (existing) {
    // Phase-1 docker executor migration: 1.0.0 → 1.1.0 is an additive, backwards-
    // compatible bump. The docker substrate is opt-in via the profile's optional
    // environment.image; the host execution path is byte-for-byte unchanged
    // (same commands, same routing, same tree-kill). Migrate the trust row in
    // place rather than drifting. The digest bump means all prior receipts are
    // re-checked exactly once (by design) — the provider still fails closed on
    // any real policy change (category/determinism/status tampering).
    // 1.1 added opt-in Docker; 1.2 sealed the manifest-bound subject policy;
    // 1.5 the sealed manifest-bound subject policy; 1.6 added the compose
    // verification step and typed seam repair-issue emission; 1.7 the M2-2
    // ADDITIVE test-coverage report. 1.8 adds the D1 sourceCandidate-keyed
    // receipt binding (evidence append + bytes-keyed replay/conflict lookup).
    // 1.9 the M1-b derived-canonical executed set (declarations additive-only).
    // 1.11 (CC-GAP-9 / ADR-089) reclassifies the two docker
    // environment-precondition codes from 'failed' to bounded in-check retry
    // then typed unknown `warrant-blocked-environment` — an honest outcome
    // semantics change on exactly that class; all other outcomes unchanged.
    // All additive; the versioned CheckPlan still pins exact code. The digest
    // bump means all prior receipts are re-checked exactly once (by design).
    const trustworthyBaseline = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.3.1', '1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0'].includes(existing.version ?? '')
      && existing.category === 'deterministic_evidence'
      && existing.determinism === 'full'
      && existing.scope === 'local-runnability'
      && existing.status === 'active';
    if (trustworthyBaseline) {
      db.prepare(
        `UPDATE trusted_providers SET version=?, trust_basis=?
          WHERE project_id IS NULL AND name=?`,
      ).run(
        LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
        `built-in:${LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST}`,
        LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
      );
      return;
    }
    if (existing.version !== LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION
        || existing.trust_basis !== `built-in:${LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST}`
        || existing.category !== 'deterministic_evidence'
        || existing.determinism !== 'full'
        || existing.scope !== 'local-runnability'
        || existing.status !== 'active') {
      throw new Error('LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT');
    }
    return;
  }
  db.prepare(
    `INSERT INTO trusted_providers
      (project_id,name,version,category,trust_basis,determinism,scope,status)
     VALUES (NULL,?,?,'deterministic_evidence',?,'full',?,'active')`,
  ).run(
    LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
    LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    `built-in:${LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST}`,
    'local-runnability',
  );
}

function resolveSubject(
  input: { db: SqlDatabasePort; candidateSets: CandidateSetReaderPort },
  candidateSetRef: string,
  parameters: Readonly<Record<string, unknown>>,
): CandidateSubject {
  // ADR-053 — prove runnable the EXACT integrated-candidate product sealed as a
  // member of the accepted CandidateSet. The subject is resolved by the member's
  // content-addressed ProductRef, NEVER by a "newest product for this
  // process/kind" query: that crosses the recoding boundary ADR-053 closes (a
  // later attempt or a concurrent repair could otherwise change which row the
  // process/kind lookup resolves to while the sealed authority stays fixed).
  // When the exact candidate set is absent, non-author, carries no sealed
  // integrated-candidate member, or the sealed product row is missing, fail
  // closed — do not guess.
  const subjectSet = input.candidateSets.read(candidateSetRef);
  // Try the named subject set first. When it is an author set that carries the
  // integrated-candidate member, that IS the authority.
  let set = (subjectSet && subjectSet.role === 'author') ? subjectSet : null;
  let member = set?.members.find(
    candidate => candidate.productRef.schemaId === INTEGRATED_CANDIDATE_SCHEMA,
  ) ?? null;
  const explicitProduct = parameters.upstreamProductSchema === INTEGRATED_CANDIDATE_SCHEMA
    && typeof parameters.upstreamProductRef === 'string'
    && typeof parameters.upstreamProductDigest === 'string'
    ? {
        schemaId: parameters.upstreamProductSchema,
        ref: parameters.upstreamProductRef,
        digest: parameters.upstreamProductDigest,
      }
    : null;
  let evidenceBoundProduct = explicitProduct ?? readIntegratedCandidateBoundByEvidence(
    input, subjectSet,
  );
  let manifestReadiness: unknown = undefined;
  const manifestMember = set?.members.find(candidate =>
    candidate.productRef.schemaId === DEVELOPMENT_READINESS_MANIFEST_SCHEMA);
  if (set && manifestMember?.productRef.ref.startsWith('managed-node-submission:')) {
    const id = Number(manifestMember.productRef.ref.slice('managed-node-submission:'.length));
    const row = Number.isSafeInteger(id) ? input.db.prepare(
      `SELECT payload_snapshot FROM factory_managed_node_submissions
        WHERE id=? AND process_run_id=? AND schema_version=? AND content_hash=?`,
    ).get(
      id,
      set.workplaceRef.processRunId,
      DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
      manifestMember.productRef.digest,
    ) as { payload_snapshot: string } | undefined : undefined;
    if (!row) throw new Error('LOCAL_READINESS_MANIFEST_MISSING');
    const manifest = JSON.parse(row.payload_snapshot) as {
      sourceCandidate?: { schema?: unknown; ref?: unknown; hash?: unknown };
      targets?: Array<{ key?: unknown; readiness?: unknown }>;
    };
    if (manifest.sourceCandidate?.schema !== INTEGRATED_SOURCE_CANDIDATE_SCHEMA
        || typeof manifest.sourceCandidate.ref !== 'string'
        || typeof manifest.sourceCandidate.hash !== 'string'
        || !Array.isArray(manifest.targets)
        || manifest.targets.length !== 1
        || manifest.targets[0]?.key !== 'primary') {
      throw new Error('LOCAL_READINESS_MANIFEST_INVALID');
    }
    evidenceBoundProduct = {
      schemaId: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
      ref: manifest.sourceCandidate.ref,
      digest: manifest.sourceCandidate.hash,
    };
    manifestReadiness = manifest.targets[0].readiness;
  }
  // LR-01 fallback — the integrated candidate is a kernel-produced (freeze)
  // process product sealed into a freeze-authority CandidateSet, NOT the
  // verification-evidence set the gate named as subject. When the subject lacks
  // the member, resolve the freeze-authority author CandidateSet in the same
  // process run (the member's content-addressed triple is the exact sealed
  // candidate). This preserves exact-member resolution — the product is read by
  // its immutable ProductRef, never by recency.
  if (!member && !evidenceBoundProduct) {
    const processRunId = subjectSet?.workplaceRef.processRunId
      ?? extractProcessRunIdFromRef(candidateSetRef);
    if (processRunId !== null) {
      const altSet = readFreezeAuthorityCandidateSet(input, processRunId);
      if (altSet) {
        set = altSet;
        member = altSet.members.find(
          candidate => candidate.productRef.schemaId === INTEGRATED_CANDIDATE_SCHEMA,
        ) ?? null;
      }
    }
  }
  if (!set || set.role !== 'author') throw new Error('LOCAL_READINESS_SUBJECT_MISSING');
  if (!member && !evidenceBoundProduct) throw new Error('LOCAL_READINESS_SUBJECT_NOT_SEALED');
  const { schemaId, ref, digest } = evidenceBoundProduct ?? member!.productRef;
  if (typeof ref !== 'string' || ref.length === 0
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('LOCAL_READINESS_CANDIDATE_INVALID');
  }
  // Read the EXACT sealed product by its content-addressed identity
  // (schema_id + artifact_ref + product_hash), scoped to the candidate set's
  // process run only to disambiguate replayed content across runs. No
  // process/kind recency lookup — the ProductRef is the authority.
  const product = input.db.prepare(
    `SELECT payload_snapshot
       FROM factory_process_products
      WHERE process_run_id=? AND schema_id=? AND artifact_ref=? AND product_hash=?`,
  ).get(set.workplaceRef.processRunId, schemaId, ref, digest) as
    { payload_snapshot: string } | undefined;
  if (!product) throw new Error('LOCAL_READINESS_CANDIDATE_MISSING');
  const candidate = JSON.parse(product.payload_snapshot) as {
    candidateHash?: unknown;
    sourceHash?: unknown;
    repositories?: Array<{
      projectRepositoryId?: unknown;
      commitSha?: unknown;
      treeHash?: unknown;
    }>;
    // LR-04 — the explicit served|static readiness profile stated by the
    // accepted product. Parsed here (part of the frozen payload); validated and
    // consumed by runLocalReadiness. The profile carries the runnability
    // commands (LR-03 RunnabilityCommands) and names the readiness shape.
    readiness?: unknown;
  };
  const candidateHash = typeof candidate.candidateHash === 'string'
    ? candidate.candidateHash
    : candidate.sourceHash;
  if (typeof candidateHash !== 'string'
      || !Array.isArray(candidate.repositories)
      || candidate.repositories.length !== 1) {
    throw new Error('LOCAL_READINESS_CANDIDATE_INVALID');
  }
  const repository = candidate.repositories[0]!;
  if (!Number.isSafeInteger(repository.projectRepositoryId)
      || typeof repository.commitSha !== 'string'
      || !OBJECT_ID_RE.test(repository.commitSha)
      || typeof repository.treeHash !== 'string'
      || !OBJECT_ID_RE.test(repository.treeHash)) {
    throw new Error('LOCAL_READINESS_REPOSITORY_INVALID');
  }
  const binding = input.db.prepare(
    'SELECT local_path FROM project_repositories WHERE id=?',
  ).get(repository.projectRepositoryId) as { local_path: string | null } | undefined;
  if (!binding?.local_path) throw new Error('LOCAL_READINESS_REPOSITORY_MISSING');
  // ADR-053 / LR-02 — bind the runnability proof to the EXACT content-addressed
  // git object sealed in the product. The authority is the immutable commit SHA
  // + tree SHA, NEVER a moving ref, branch tip, HEAD, or a working-tree
  // checkout. We read each object by identity from the object DB (git cat-file)
  // and refuse anything that is not the exact sealed object — no checkout, no
  // ref resolution, no mutation of the canonical branch.
  verifyExactObjectAuthority(binding.local_path, repository.commitSha, repository.treeHash);
  return {
    repositoryPath: binding.local_path,
    commitSha: repository.commitSha,
    treeHash: repository.treeHash,
    candidateHash,
    processRunId: set.workplaceRef.processRunId,
    readiness: manifestReadiness ?? candidate.readiness,
  };
}

function readIntegratedCandidateBoundByEvidence(
  input: { db: SqlDatabasePort; candidateSets: CandidateSetReaderPort },
  subjectSet: CandidateSet | null,
): { schemaId: string; ref: string; digest: string } | null {
  const evidence = subjectSet?.members.find(
    member => member.productRef.schemaId
      === 'factory.candidate-verification-evidence-product.v2',
  );
  if (!subjectSet || !evidence?.productRef.ref.startsWith('managed-node-submission:')) {
    return null;
  }
  const submissionId = Number(evidence.productRef.ref.slice('managed-node-submission:'.length));
  if (!Number.isSafeInteger(submissionId) || submissionId < 1) return null;
  const row = input.db.prepare(
    `SELECT payload_snapshot FROM factory_managed_node_submissions
      WHERE id=? AND process_run_id=? AND content_hash=?`,
  ).get(submissionId, subjectSet.workplaceRef.processRunId, evidence.productRef.digest) as
    { payload_snapshot: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload_snapshot) as { candidateHash?: unknown };
  if (typeof payload.candidateHash !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.candidateHash)) {
    return null;
  }
  const product = input.db.prepare(
    `SELECT artifact_ref,product_hash FROM factory_process_products
      WHERE process_run_id=? AND schema_id=? AND product_hash=?`,
  ).get(
    subjectSet.workplaceRef.processRunId,
    INTEGRATED_CANDIDATE_SCHEMA,
    payload.candidateHash,
  ) as { artifact_ref: string; product_hash: string } | undefined;
  return product ? {
    schemaId: INTEGRATED_CANDIDATE_SCHEMA,
    ref: product.artifact_ref,
    digest: product.product_hash,
  } : null;
}

/**
 * LR-01 fallback — read the freeze-authority author CandidateSet for a process
 * run: the set whose single member is the integrated-candidate process product
 * sealed by the kernel freeze. Returns null when no such set exists (the
 * provider then fails closed with LOCAL_READINESS_SUBJECT_NOT_SEALED). The
 * lookup is by exact member schema (INTEGRATED_CANDIDATE_SCHEMA), never by
 * recency; there is at most one frozen candidate per process run.
 */
function readFreezeAuthorityCandidateSet(
  input: { db: SqlDatabasePort; candidateSets: CandidateSetReaderPort },
  processRunId: number,
): CandidateSet | null {
  let rows: Array<{ ref: string }>;
  try {
    rows = input.db.prepare(
      `SELECT cs.candidate_set_ref AS ref
         FROM factory_candidate_sets cs
         JOIN factory_workplaces w
           ON w.workplace_ref=cs.workplace_ref AND w.process_run_id=?
         JOIN factory_candidate_set_members m
           ON m.candidate_set_ref=cs.candidate_set_ref
          AND m.product_schema=?
        WHERE cs.role='author'
        ORDER BY cs.candidate_set_ref`,
    ).all(processRunId, INTEGRATED_CANDIDATE_SCHEMA) as Array<{ ref: string }>;
  } catch {
    return null;
  }
  if (rows.length !== 1) return null;
  return input.candidateSets.read(rows[0]!.ref);
}

/**
 * Best-effort extraction of a processRunId from a candidate_set_ref whose
 * workplace was not readable (absent set). The freeze-authority ref embeds the
 * processRunId in its artifact_ref segment. Returns null when no integer
 * processRunId can be parsed.
 */
function extractProcessRunIdFromRef(candidateSetRef: string): number | null {
  const match = candidateSetRef.match(/\/(\d+)\//u) ?? candidateSetRef.match(/:(\d+):/u);
  if (!match) return null;
  const id = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function runLocalReadiness(
  db: SqlDatabasePort,
  subject: CandidateSubject,
  subjectCandidateSetRef: string,
  composeRunner: ComposeRunner,
  substrateOptions: {
    selectExecutor: (
      directory: string,
      profile: ReadinessProfile,
    ) => ReadinessExecutor;
    sleep?: (ms: number) => void;
  },
): CheckProviderResult {
  const directory = mkdtempSync(join(tmpdir(), 'saga-local-readiness-'));
  const archive = join(directory, 'candidate.tar');
  let executor: ReadinessExecutor | null = null;
  // M2-2 — ADDITIVE coverage evidence (report only, never enforcing): which
  // test files the sealed tree's canonical set contains vs which the declared
  // testCommand runs. Computed as soon as the profile validates; rides BOTH
  // passed and failed outcomes.
  let coverage: { observation: Record<string, unknown>; message: string } | null = null;
  // K19 — the derived-environment message, set inside try, read by catch.
  let finalEnvironmentMessage: string | undefined;
  // SEAM-ARCHITECT Layer 2 (b) — which seam is being verified RIGHT NOW. On
  // failure this tracker (not a boolean) determines the typed SeamRepairIssue:
  // seamKind by phase, localization (phase/command/substrate), owner resolved
  // from the failure output's file hints through the task graph change scopes.
  const seam: {
    seamKind: SeamKind;
    phase: string;
    command?: string;
  } = { seamKind: 'readiness-profile-invalid', phase: 'readiness-profile' };
  try {
    // ADR-053 / LR-02 — read the exact sealed object by identity. The archive
    // is generated from the content-addressed commitSha verified above (whose
    // tree === subject.treeHash); it is NOT a checkout of a ref, tip, or the
    // working tree, and it never mutates the canonical branch.
    const tar = execFileSync('git', [
      '-C', subject.repositoryPath, 'archive', '--format=tar', subject.commitSha,
    ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(archive, tar);
    // NEVER pass an absolute Windows path to tar: GNU tar (Git-for-Windows
    // shadows System32 bsdtar in PATH) parses `C:\...` as its `host:path`
    // remote syntax and fails with "Cannot connect to C: resolve failed",
    // while bsdtar has no `--force-local`. Running tar with cwd=directory and
    // a RELATIVE archive name sidesteps both grammars on every platform: a
    // colon-free relative name cannot be mistaken for a remote spec.
    execFileSync('tar', ['-xf', 'candidate.tar'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    // LR-04 — the EXPLICIT readiness profile (served | static) is the single
    // authority for how the exact sealed product proves itself runnable. The
    // provider does NOT infer served/static (or product kind) from package.json
    // / build files; it fails closed when the profile is absent or invalid
    // rather than guessing readiness from incidental files.
    const profile = validateReadinessProfile(subject.readiness);
    if (profile === null) {
      return evidence('failed', subject, {
        reason:
          'product contract does not state an explicit readiness profile '
          + '(readiness.kind must be "served" or "static" with valid commands; '
          + 'served also requires serve.startCommand); refusing to infer '
          + 'readiness from incidental files',
      }, undefined, buildSeamIssue(db, {
        seamKind: 'readiness-profile-invalid',
        phase: 'readiness-profile',
        substrate: 'host',
        command: undefined,
        fileHints: [],
        summary: 'the frozen readiness profile is absent or invalid; the product contract must state kind/commands (and serve.startCommand for served)',
      }, subject, subjectCandidateSetRef));
    }
    // M2-2 — derive the canonical test-file universe from the EXACT sealed
    // tree (tests/** plus the sealed package.json scripts.test enumeration)
    // and the executed set from the declaration (opaque npm-test resolved
    // through the SAME sealed package.json, never the declaration's word).
    // Purely additive evidence: it never influences the outcome below.
    coverage = computeTestCoverageReport(directory, profile);
    // M1-b (step 4) — DERIVED-CANONICAL ENFORCEMENT. The executed check set
    // is derived from the order (the sealed tree); the candidate's
    // declaration is ADDITIVE ONLY — it may add test files, never remove or
    // replace the canonical ones. When a resolvable declaration falls short
    // of the canonical universe, the gate derives the executed command by
    // extending the declaration's own runner and flags with the missing
    // canonical files (token surgery, readiness-test-surface): the excluded
    // files RUN, so excluding exactly the red ones can no longer pass.
    // Unresolved-opaque declarations remain report-only (the M2-2 boundary,
    // unchanged) — the report still names the universe they never touched.
    const enforced = enforceDerivedCanonicalTestSet({
      profile,
      canonicalFiles: (coverage.observation.canonicalTestFiles as string[]) ?? [],
      sealedPackageJsonTestScript: readSealedPackageJsonTestScript(directory),
    });
    if (enforced.status === 'gate-derived') {
      coverage.observation.derivation = {
        status: 'gate-derived-canonical-set',
        executedTestCommand: enforced.testCommand,
        addedCanonicalFiles: [...enforced.addedFiles],
      };
      coverage.message += '; the gate DERIVED the executed command from the sealed tree, adding: '
        + enforced.addedFiles.join(', ');
    }
    const effectiveTestCommand = enforced.testCommand;
    // K19 (ADR-083 §2.1/2.2, train commits 2–3 core) — the DERIVED EXECUTION
    // ENVIRONMENT. The environment is derived from the exact sealed tree
    // (what the artefact imports vs what the manifests and the declared
    // install provide); the declaration is additive, never definitive. An
    // undeclared import — the GDesign class (imported, not declared, the
    // worker's polluted environment hid it until the sterile container
    // caught it by luck) — is caught BY DERIVATION, before any spawn:
    // augments the install with the missing packages, or fails closed with
    // a typed diagnostic when there is no install to augment. The derived
    // identity (environmentDigest) rides every outcome — preparation and
    // certification hold one immutable object.
    const environment = deriveExecutionEnvironment({
      directory,
      installCommand: profile.commands.installCommand,
    });
    const environmentObservation: Record<string, unknown> = {
      environmentDigest: environment.environmentDigest,
      ...(environment.undeclaredImports.length > 0
        ? { undeclaredImports: [...environment.undeclaredImports] }
        : {}),
    };
    const environmentMessage = 'derived environment ' + environment.environmentDigest.slice(0, 16)
      + (environment.undeclaredImports.length > 0
        ? '; undeclared import(s) the derived environment must provide: '
          + environment.undeclaredImports.join(', ')
        : '; declared environment covers the sealed artefact');
    let effectiveInstallCommand = profile.commands.installCommand;
    if (environment.undeclaredImports.length > 0) {
      if (profile.commands.installCommand === null) {
        return evidence('failed', subject, {
          reason:
            'ENVIRONMENT_DERIVATION_UNDECLARED_NEED: the sealed artefact imports package(s) '
            + environment.undeclaredImports.join(', ')
            + ' that no sealed manifest declares and the readiness profile states NO install '
            + 'command to augment — the derived environment cannot be prepared. Declared by '
            + 'derivation from the sealed tree, before any execution.',
          ...(coverage ? { testCoverage: coverage.observation } : {}),
          ...environmentObservation,
        }, 'ENVIRONMENT_DERIVATION_UNDECLARED_NEED', buildSeamIssue(db, {
          seamKind: 'install-command',
          phase: 'environment-derivation',
          substrate: 'host',
          command: undefined,
          fileHints: [],
          summary: `undeclared import(s) ${environment.undeclaredImports.join(', ')}; no install command to augment`,
        }, subject, subjectCandidateSetRef), coverage?.message, environmentMessage);
      }
      effectiveInstallCommand = augmentInstallCommand(
        profile.commands.installCommand,
        environment.undeclaredImports,
      );
      environmentObservation.derivedInstallCommand = effectiveInstallCommand;
    }
    finalEnvironmentMessage = environmentMessage
      + (environmentObservation.derivedInstallCommand !== undefined
        ? '; install augmented to: ' + String(environmentObservation.derivedInstallCommand)
        : '');
    // The COMMAND AUTHORITY is the frozen profile; the executor decides WHERE
    // (host or docker). When the profile declares environment.image, the docker
    // executor is selected (unless SAGA_LOCAL_RUNNABILITY_EXEC=host forces the
    // host path).
    const phases: string[] = [];
    // Typed per-step results (SEAM Layer 2 (a)): every step of the assembled
    // whole's verification records a typed entry — never a bare boolean.
    const steps: Array<{ step: string; status: 'passed' }> = [];
    const step = (name: string): void => {
      phases.push(name);
      steps.push({ step: name, status: 'passed' });
    };
    // Prepare one environment from the exact candidate and the profile-stated
    // install command. Docker freezes post-install state as a disposable OCI
    // image; host uses its disposable tree/venv. prepare runs even when the
    // profile states NO install command: the docker executor's prepare(null)
    // still builds the prepared image (substrate preparation is not optional).
    if (effectiveInstallCommand !== null) {
      seam.seamKind = 'install-command';
      seam.phase = 'profile-install';
      seam.command = effectiveInstallCommand;
    }
    // CC-GAP-9 / ADR-089 — BOUNDED DETERMINISTIC IN-CHECK SUBSTRATE RETRY.
    // A missing environment precondition (docker daemon down / not linux —
    // exactly the two frozen codes in substrate-retry.ts) is retried inside
    // the check: a frozen attempt bound and schedule, no model, no
    // WorkerExecution, no CandidateSet, no repair epoch, no worker repair
    // budget consumed. Each attempt genuinely re-probes the precondition:
    // the process-level docker availability cache is invalidated BEFORE the
    // first attempt (a stale entry left by a previous check in the same
    // engine process would either mask a down daemon as a non-precondition
    // pull failure — 'failed', the exact Elite-6 machine-fault-as-product-
    // verdict shape — or replay a cached miss as attempt-1 evidence) and
    // again between attempts (betweenAttempts below). On exhaustion the
    // check emits the typed unknown `warrant-blocked-environment` outcome —
    // never 'failed' (the product was never exercised), never 'error'
    // (which the gate would retry forever). Non-precondition failures
    // (command failures, pull failures, product failures) propagate
    // unchanged and keep their 'failed' + typed seam repair-issue semantics
    // in the catch below.
    resetDockerAvailabilityCache();
    const substrate = runBoundedSubstrateRetry({
      attempt: () => {
        const attemptExecutor = substrateOptions.selectExecutor(directory, profile);
        try {
          attemptExecutor.prepare(effectiveInstallCommand, 240_000);
        } catch (error) {
          try { attemptExecutor.dispose(); } catch { /* best-effort cleanup */ }
          throw error;
        }
        return attemptExecutor;
      },
      betweenAttempts: resetDockerAvailabilityCache,
      ...(substrateOptions.sleep ? { sleep: substrateOptions.sleep } : {}),
    });
    if (substrate.status === 'exhausted') {
      return substrateUnknownEvidence(
        substrate.attempts,
        subject,
        {
          ...(coverage ? { testCoverage: coverage.observation } : {}),
        },
        coverage?.message,
        finalEnvironmentMessage,
      );
    }
    executor = substrate.result;
    if (profile.commands.installCommand !== null) {
      step('profile-install');
    }
    // Test (deterministic, from the profile) — the runnability authority.
    // M1-b: when the declaration fell short of the canonical set, the
    // EXECUTED command is the gate-derived one (same runner, canonical files
    // included); otherwise it is the declared command verbatim.
    seam.seamKind = 'test-command';
    seam.phase = 'profile-test';
    seam.command = effectiveTestCommand;
    executor.runCommand(effectiveTestCommand, 600_000);
    step('profile-test');
    // Additive substrate evidence (free in the digest).
    const desc = executor.describe();
    const substrateEvidence: Record<string, unknown> = {
      substrate: desc.substrate,
      ...(desc.image !== undefined ? { image: desc.image } : {}),
      ...(desc.detectedBuildSystem !== undefined
        ? { detectedBuildSystem: desc.detectedBuildSystem }
        : {}),
    };
    if (profile.kind === 'served') {
      // LR-04 — the SERVED profile states how the product serves. The provider
      // starts the stated serve command, probes loopback, and shuts it down.
      // The serve command comes from the explicit profile, NOT from
      // package.json.scripts.start. ADDITIVE evidence only — runnability was
      // already proven by the test command above; this proves the exact sealed
      // object can also be started, answer on loopback, and stop.
      const port = 20_000 + (Number.parseInt(subject.candidateHash.slice(0, 6), 16) % 20_000);
      seam.seamKind = 'serve-start';
      seam.phase = 'profile-serve';
      seam.command = profile.serve.startCommand;
      const serveEvidence = executor.runServed(profile.serve.startCommand, 15_000, port);
      step('profile-serve');
      step('loopback-http-probe');
      step('clean-shutdown');
      // Compose verification of the assembled whole (SEAM Layer 2 (a)). The
      // declaration is TYPED on the frozen profile — never an inference from
      // compose files incidentally present in the tree.
      const composeObservation = runDeclaredCompose(
        directory, profile, composeRunner, seam,
      );
      for (const name of composeObservation.phases) step(name);
      return evidence('passed', subject, {
        phases,
        steps,
        readinessKind: 'served',
        ...substrateEvidence,
        ...serveEvidence,
        ...(composeObservation.evidence ? { compose: composeObservation.evidence } : {}),
        ...(coverage ? { testCoverage: coverage.observation } : {}),
      }, undefined, undefined, coverage?.message, finalEnvironmentMessage);
    }
    const composeObservation = runDeclaredCompose(
      directory, profile, composeRunner, seam,
    );
    for (const name of composeObservation.phases) step(name);
    return evidence('passed', subject, {
      phases,
      steps,
      readinessKind: 'static',
      ...substrateEvidence,
      ...(composeObservation.evidence ? { compose: composeObservation.evidence } : {}),
      ...(coverage ? { testCoverage: coverage.observation } : {}),
      note: 'runnability proven by the profile-stated install/test commands',
    }, undefined, undefined, coverage?.message, finalEnvironmentMessage);
  } catch (error) {
    // A ReadinessExecutionError carries a specific diagnostic code (e.g.
    // LOCAL_RUNNABILITY_DOCKER_PULL_FAILED) that the evidence function encodes
    // into a decodable check-diagnostic so the verifier's recovery feedback
    // names the exact substrate failure. CC-GAP-9 / ADR-089: the two
    // environment-precondition codes (DOCKER_UNAVAILABLE / DOCKER_NOT_LINUX)
    // never reach this catch — the bounded in-check retry above returns the
    // typed unknown `warrant-blocked-environment` outcome on exhaustion, so a
    // missing environment precondition is never recorded as a product
    // 'failed' verdict (the Elite-6 CC-00C F8/F10 defect).
    const isSubstrateError = error instanceof ReadinessExecutionError;
    const code = isSubstrateError ? error.code : undefined;
    const seamKind: SeamKind = isSubstrateError ? 'substrate-unavailable' : seam.seamKind;
    const refined = refineServeSeamKind(error, seamKind);
    return evidence(
      'failed',
      subject,
      {
        reason: errorMessage(error),
        ...(coverage ? { testCoverage: coverage.observation } : {}),
      },
      code,
      buildSeamIssue(db, {
        seamKind: refined,
        phase: seam.phase,
        substrate: executor?.describe().substrate ?? 'host',
        command: seam.command,
        fileHints: extractFileHints(errorMessage(error)),
        summary: errorMessage(error).slice(0, 2000),
      }, subject, subjectCandidateSetRef),
      coverage?.message,
      finalEnvironmentMessage,
    );
  } finally {
    // Release substrate resources (docker volumes) before removing the temp
    // directory. Best-effort: a dispose failure must not mask the real result.
    try { executor?.dispose(); } catch { /* best-effort cleanup */ }
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * SEAM-ARCHITECT Layer 2 (a) — run the compose verification declared by the
 * frozen readiness profile. Config validation ALWAYS (the mandatory minimum);
 * a bounded `up --wait` then `down` in the full mode. Every step returns a
 * typed result; a failed step throws a plain Error whose message is the typed
 * detail (the seam tracker has already been set to the compose phase by the
 * caller). `down` always runs after `up` — clean shutdown even on failure.
 */
function runDeclaredCompose(
  directory: string,
  profile: ReadinessProfile,
  composeRunner: ComposeRunner,
  seam: { seamKind: SeamKind; phase: string; command?: string },
): {
  phases: string[];
  evidence: Record<string, unknown> | null;
} {
  const declared = validateComposeDeclaration(
    (profile as { compose?: unknown }).compose,
  );
  if (declared === null) return { phases: [], evidence: null };
  const phases: string[] = [];
  const evidence: Record<string, unknown> = { file: declared.file };
  seam.seamKind = 'compose-config';
  seam.phase = 'compose-config';
  seam.command = `docker compose -f ${declared.file} config`;
  const config = composeRunner.configValidate(directory, declared);
  if (config.status === 'failed') {
    throw new Error(config.detail ?? 'docker compose config validation failed');
  }
  phases.push('compose-config-validate');
  if (composeModeFromEnvironment() === 'up') {
    seam.seamKind = 'compose-up';
    seam.phase = 'compose-up';
    seam.command = `docker compose -f ${declared.file} up -d --wait`;
    let up;
    try {
      up = composeRunner.up(directory, declared, DEFAULT_COMPOSE_UP_TIMEOUT_MS);
    } finally {
      // Clean shutdown even on a failed up — the composition must never leak.
      try {
        composeRunner.down(directory, declared);
      } catch { /* best-effort; must not mask the up failure */ }
    }
    if (up.status === 'failed') {
      throw new Error(up.detail ?? 'docker compose up failed');
    }
    phases.push('compose-up-wait', 'compose-down');
  }
  return { phases, evidence };
}

/**
 * Classify a serve-phase failure into the precise serve seam kind using the
 * ServedProcessError code (typed, not message matching). Non-serve failures
 * and docker-executor serve failures keep the tracked seam kind.
 */
function refineServeSeamKind(error: unknown, tracked: SeamKind): SeamKind {
  if (tracked !== 'serve-start') return tracked;
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case 'SERVED_PROCESS_PROBE_FAILED':
      return 'serve-probe';
    case 'SERVED_PROCESS_TERMINATION_FAILED':
      return 'serve-shutdown';
    default:
      return tracked;
  }
}

/** Deterministic repo-relative file-path extraction from failure output. */
export function extractFileHints(text: string): string[] {
  const hints = new Set<string>();
  const tokenRe = /[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]{1,8}/gu;
  for (const match of text.matchAll(tokenRe)) {
    const token = match[0];
    // Repo-relative source paths only: must contain '/', no protocol/host
    // noise, no node_modules internals (dependency noise, not seam material).
    if (token.includes('/') && !token.includes('://') && !token.startsWith('node_modules/')
      && !token.includes('/node_modules/')) {
      hints.add(token.replace(/^\.\//u, ''));
    }
    if (hints.size >= 5) break;
  }
  return [...hints];
}

/**
 * SEAM-ARCHITECT Layer 2 (c) — resolve the PRODUCING task that owns the seam:
 * read the canonical task graph product, find implementation items whose
 * declared change scopes cover the localized file hints, and map them to their
 * projected task ids. Exactly one distinct owner → `task:<id>`; zero or
 * several → the typed integration seam (a cross-item defect no single task
 * owns — the SEAM Layer 3 reconciliation case). Fail-open typed fallback only:
 * the failure evidence itself stays fail-closed.
 */
function resolveSeamProducingTask(
  db: SqlDatabasePort,
  processRunId: number,
  fileHints: readonly string[],
): string {
  if (fileHints.length === 0) return 'seam:integration';
  let scopes: Array<{ key: string; changeScopes: string[] }>;
  try {
    const row = db.prepare(
      `SELECT payload_snapshot FROM factory_process_products
        WHERE process_run_id=? AND product_kind='development.task-graph'`,
    ).get(processRunId) as { payload_snapshot: string } | undefined;
    if (!row) return 'seam:integration';
    const graph = JSON.parse(row.payload_snapshot) as {
      implementationItems?: Array<{ key?: unknown; changeScopes?: unknown }>;
    };
    if (!Array.isArray(graph.implementationItems)) return 'seam:integration';
    scopes = graph.implementationItems
      .filter((item): item is { key: string; changeScopes: string[] } =>
        typeof item.key === 'string'
        && Array.isArray(item.changeScopes)
        && item.changeScopes.every(scope => typeof scope === 'string'))
      .map(item => ({ key: item.key, changeScopes: item.changeScopes }));
  } catch {
    return 'seam:integration';
  }
  const owners = new Set<string>();
  for (const hint of fileHints) {
    for (const item of scopes) {
      if (item.changeScopes.some(scope => {
        try {
          return repositoryScopeCovers(scope, hint);
        } catch {
          return false;
        }
      })) {
        owners.add(item.key);
      }
    }
  }
  if (owners.size !== 1) return 'seam:integration';
  const [key] = owners;
  try {
    const projected = db.prepare(
      `SELECT task_id FROM factory_development_task_projections
        WHERE process_run_id=? AND item_kind='implementation' AND work_item_key=?`,
    ).get(processRunId, key) as { task_id: number } | undefined;
    if (projected && Number.isSafeInteger(projected.task_id) && projected.task_id > 0) {
      return `task:${projected.task_id}`;
    }
  } catch {
    // projections table absent — fall through to the cell-level fallback
  }
  return 'seam:integration';
}

/**
 * Resolve the producing task for a readiness-PROFILE defect: the readiness
 * manifest is authored by the development-readiness-certification cell; its
 * accepted-author head names the exact task. Typed fallback names the cell
 * when no accepted head is bound (e.g. the profile rode on the candidate
 * payload directly).
 */
function resolveProfileProducingTask(
  db: SqlDatabasePort,
  processRunId: number,
): string {
  try {
    const row = db.prepare(
      `SELECT h.accepted_author_task_id AS taskId
         FROM factory_workplaces w
         JOIN factory_accepted_authority_head h
           ON h.workplace_ref=w.workplace_ref
        WHERE w.process_run_id=?
          AND w.production_cell_id='development-readiness-certification'
          AND w.loop_state='terminal'
          AND w.terminal_reason='accepted'`,
    ).get(processRunId) as { taskId: string | null } | undefined;
    if (row?.taskId && Number.parseInt(row.taskId, 10) > 0) {
      return `task:${row.taskId}`;
    }
  } catch {
    // tables absent in a minimal store — typed cell fallback below
  }
  return 'cell:development-readiness-certification';
}

function buildSeamIssue(
  db: SqlDatabasePort,
  input: {
    seamKind: SeamKind;
    phase: string;
    substrate: 'host' | 'docker';
    command: string | undefined;
    fileHints: string[];
    summary: string;
  },
  subject: CandidateSubject,
  subjectCandidateSetRef: string,
): SeamRepairIssue {
  const producingTaskRef = input.seamKind === 'readiness-profile-invalid'
    ? resolveProfileProducingTask(db, subject.processRunId)
    : resolveSeamProducingTask(db, subject.processRunId, input.fileHints);
  return {
    seamKind: input.seamKind,
    producingTaskRef,
    localization: {
      phase: input.phase,
      substrate: input.substrate,
      ...(input.command !== undefined ? { command: input.command } : {}),
      fileHints: input.fileHints,
    },
    evidence: {
      summary: input.summary,
      digestRef: `local-readiness:${sha256Hex({
        candidateHash: subject.candidateHash,
        commitSha: subject.commitSha,
        seamKind: input.seamKind,
        phase: input.phase,
      })}`,
    },
    subjectCandidateSetRef,
  };
}

/**
 * Select the execution substrate for this readiness check. The profile is the
 * COMMAND AUTHORITY; this function decides WHERE the commands run:
 *
 *   - SAGA_LOCAL_RUNNABILITY_EXEC=host → always host (forces host even when an
 *     image is declared — useful for debugging / docker-less CI).
 *   - auto (default) / docker → docker when the profile declares
 *     environment.image; host otherwise (backwards-compatible).
 *
 * When docker is selected but the daemon precondition is missing, the
 * DockerReadinessExecutor throws LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE /
 * LOCAL_RUNNABILITY_DOCKER_NOT_LINUX on first use (inside runLocalReadiness's
 * bounded substrate retry), which retries the precondition up to the frozen
 * in-check bound and on exhaustion emits the typed unknown
 * `warrant-blocked-environment` outcome (CC-GAP-9 / ADR-089) — never a
 * product 'failed' verdict.
 */
function selectReadinessExecutor(
  directory: string,
  profile: ReadinessProfile,
): ReadinessExecutor {
  const mode = (process.env.SAGA_LOCAL_RUNNABILITY_EXEC ?? 'auto').toLowerCase();
  const declaredImage = profile.environment?.image;
  if (mode === 'host') {
    return new HostReadinessExecutor(directory, profile);
  }
  if (declaredImage !== undefined) {
    return new DockerReadinessExecutor(directory, declaredImage);
  }
  return new HostReadinessExecutor(directory, profile);
}

/**
 * Host execution substrate — preserves the exact pre-Phase-1 behavior. Build-
 * system detection selects the JVM env (JAVA_HOME/bin); npm/node-prefixed
 * contract commands route through bundled tooling; other commands run verbatim
 * through the platform shell with leading ./ stripped on win32. The served
 * probe uses the reliable detached-process runner with whole-tree termination.
 */
class HostReadinessExecutor implements ReadinessExecutor {
  private readonly detected: 'gradle' | 'maven' | 'npm' | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly isolation: 'python-venv' | undefined;

  constructor(private readonly directory: string, profile: ReadinessProfile) {
    // Build-system detection is a VALIDATOR only (LR-03 / LR-04): it selects the
    // execution environment (JAVA_HOME/bin for JVM tooling). It is NEVER the
    // authority for readiness (served vs static) or for which commands prove
    // runnability — that is the explicit profile.
    this.detected = detectBuildSystem(this.directory);
    const baseEnv = this.detected === 'gradle' || this.detected === 'maven'
      ? jvmEnv()
      : { ...process.env };
    const pythonEnv = createPythonVirtualEnvironment(directory, profile, baseEnv);
    this.env = pythonEnv?.env ?? baseEnv;
    this.isolation = pythonEnv ? 'python-venv' : undefined;
  }

  prepare(installCommand: string | null, timeoutMs: number): void {
    if (installCommand !== null) this.runCommand(installCommand, timeoutMs);
  }

  runCommand(command: string, timeoutMs: number): void {
    runContractCommand(command, this.directory, this.env, timeoutMs);
  }

  runServed(startCommand: string, probeTimeoutMs: number, port: number): ServeEvidence {
    const target = resolveCommandTarget(startCommand);
    const observation = runServedProcess({
      cwd: this.directory,
      target,
      port,
      env: {
        ...this.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        BROWSER: 'none',
        CI: '1',
      },
      probeTimeoutMs,
    });
    return {
      port,
      pid: observation.pid,
      stdoutDigest: sha256Hex(observation.stdout),
      stderrDigest: sha256Hex(observation.stderr),
    };
  }

  describe(): ExecutorDescription {
    return {
      substrate: 'host',
      detectedBuildSystem: this.detected,
      ...(this.isolation ? { isolation: this.isolation } : {}),
    };
  }

  dispose(): void { /* host substrate has no resources to release */ }
}

/**
 * PEP 668 correctly prevents a readiness check from installing candidate
 * dependencies into the controller's system Python. When the frozen profile
 * explicitly declares a pip install, create a disposable virtualenv inside
 * the already-disposable exact-tree extraction and expose it through PATH.
 * The profile command remains byte-for-byte command authority; this function
 * chooses only the host execution substrate, just like JAVA_HOME selection.
 */
function createPythonVirtualEnvironment(
  directory: string,
  profile: ReadinessProfile,
  baseEnv: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv } | null {
  const installCommand = profile.commands.installCommand?.trim() ?? '';
  if (!/^(?:pip(?:3)?|python(?:3)?\s+-m\s+pip)(?:\s|$)/u.test(installCommand)) {
    return null;
  }
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const virtualEnv = join(directory, '.saga-readiness-python');
  try {
    execFileSync(python, ['-m', 'venv', virtualEnv], {
      cwd: directory,
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new ReadinessExecutionError(
      'LOCAL_RUNNABILITY_PYTHON_VENV_UNAVAILABLE',
      commandFailureDetail(python, ['-m', 'venv', virtualEnv], error),
    );
  }
  const bin = join(virtualEnv, process.platform === 'win32' ? 'Scripts' : 'bin');
  return {
    env: {
      ...baseEnv,
      VIRTUAL_ENV: virtualEnv,
      PATH: baseEnv.PATH ? `${bin}${delimiter}${baseEnv.PATH}` : bin,
      PYTHONNOUSERSITE: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    },
  };
}

/**
 * Validate the explicit readiness profile stated by the accepted product.
 * Returns the typed profile when the contract states a valid `served` or
 * `static` profile whose commands validate (reusing the LR-03 RunnabilityCommands
 * validator); returns null when the profile is absent or invalid so the caller
 * fails closed instead of guessing readiness from incidental files.
 */
function validateReadinessProfile(raw: unknown): ReadinessProfile | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as {
    kind?: unknown;
    commands?: unknown;
    serve?: unknown;
    environment?: unknown;
    compose?: unknown;
  };
  const commands = validateRunnability(value.commands);
  if (commands === null) return null;
  // environment is optional. When present, it MUST be { image: non-empty string }.
  // An invalid environment (wrong shape, empty/non-string image) invalidates the
  // whole profile → null → 'failed' (fail closed). The product stated a docker
  // substrate but could not state it correctly; the provider refuses to guess
  // whether to fall back to host or which image to use.
  let environment: { image: string } | undefined;
  if (value.environment !== undefined) {
    if (value.environment === null || typeof value.environment !== 'object') {
      return null;
    }
    const image = (value.environment as { image?: unknown }).image;
    if (typeof image !== 'string' || image.trim() === '') return null;
    environment = { image };
  }
  // SEAM Layer 2 (a) — an optional compose declaration. When present it MUST
  // validate (relative file inside the sealed tree); an invalid compose
  // invalidates the whole profile → null → 'failed' (fail closed), exactly
  // like an invalid environment.
  let compose: ComposeDeclaration | undefined;
  if (value.compose !== undefined) {
    const validated = validateComposeDeclaration(value.compose);
    if (validated === null) return null;
    compose = validated;
  }
  if (value.kind === 'static') {
    return environment || compose
      ? {
        kind: 'static',
        commands,
        ...(environment ? { environment } : {}),
        ...(compose ? { compose } : {}),
      }
      : { kind: 'static', commands };
  }
  if (value.kind === 'served') {
    const serve = value.serve;
    if (serve === null || typeof serve !== 'object') return null;
    const startCommand = (serve as { startCommand?: unknown }).startCommand;
    if (typeof startCommand !== 'string' || startCommand.trim() === '') return null;
    return environment || compose
      ? {
        kind: 'served',
        commands,
        serve: { startCommand },
        ...(environment ? { environment } : {}),
        ...(compose ? { compose } : {}),
      }
      : { kind: 'served', commands, serve: { startCommand } };
  }
  return null;
}

/**
 * Validate the runnability command contract embedded in a readiness profile.
 * Returns the typed commands when given a non-empty `testCommand` (and an
 * `installCommand` that is either null or a non-empty string); returns null
 * when the contract cannot state its commands, so the caller fails closed
 * instead of guessing.
 */
function validateRunnability(raw: unknown): RunnabilityCommands | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as { installCommand?: unknown; testCommand?: unknown };
  if (typeof value.testCommand !== 'string' || value.testCommand.trim() === '') {
    return null;
  }
  const { installCommand } = value;
  if (installCommand !== null
      && (typeof installCommand !== 'string' || installCommand.trim() === '')) {
    return null;
  }
  return {
    installCommand: installCommand === null ? null : installCommand,
    testCommand: value.testCommand,
  };
}

/**
 * Detect the candidate's build system from the files the worker produced. This
 * is a VALIDATOR only (LR-03 / LR-04): it cross-checks the candidate's files
 * and informs EXECUTION-ENVIRONMENT selection (JAVA_HOME/bin for JVM tooling).
 * It is NEVER the authority for WHICH commands prove runnability, and it NEVER
 * determines readiness (served vs static) or product kind — the explicit
 * readiness profile is the single authority for those.
 */
function detectBuildSystem(directory: string): 'gradle' | 'maven' | 'npm' | null {
  if (existsSync(join(directory, 'build.gradle.kts'))
      || existsSync(join(directory, 'build.gradle'))) return 'gradle';
  if (existsSync(join(directory, 'pom.xml'))) return 'maven';
  if (existsSync(join(directory, 'package.json'))) return 'npm';
  return null;
}

/**
 * Run one command stated verbatim by the product contract. The COMMAND
 * AUTHORITY is the contract string; this function only decides HOW to spawn the
 * stated program on this platform. `npm` on Windows is not a real executable
 * and the node runtime may not be on PATH in a sandbox, so `npm`/`node`-prefixed
 * contract commands route through the bundled tooling (npm-cli.js /
 * process.execPath — the same resolution `runNpm` uses); every other command
 * runs verbatim through the platform shell so the stated wrapper/script
 * (./gradlew, mvnw, …) is honored as-is.
 */
function runContractCommand(
  command: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): void {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/u);
  const [program] = tokens;
  if (program === 'npm' || program === 'npm.cmd') {
    // runNpm ALREADY throws a detailed Error (commandFailureDetail over the
    // real stdout/stderr of the resolved npm-cli invocation). Re-wrapping it
    // here would DROP those streams (the outer wrap sees a plain Error with
    // no stdout/stderr) — the seam localization would lose every file hint.
    runNpm(tokens.slice(1), directory, timeoutMs);
    return;
  }
  if (program === 'node' || program === 'node.exe') {
    try {
      execFileSync(process.execPath, tokens.slice(1), {
        cwd: directory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(commandFailureDetail(process.execPath, tokens.slice(1), error));
    }
    return;
  }
  // Run the contract's command verbatim through the platform shell so the
  // stated wrapper/script (./gradlew, mvnw, …) is honored as-is. On Windows,
  // cmd.exe cannot execute a leading "./" ('"." is not a command') — strip the
  // Unix path prefix from the program token so cmd+PATHEXT resolves the
  // sibling wrapper script (gradlew → gradlew.bat) from the candidate root.
  // Pure path normalization for the platform shell: no build-tool knowledge.
  const platformCommand = process.platform === 'win32'
    ? trimmed.replace(/^(\.\/)+/u, '')
    : trimmed;
  try {
    execFileSync(platformCommand, {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: true,
    });
  } catch (error) {
    throw new Error(commandFailureDetail(platformCommand, [], error));
  }
}

function jvmEnv(): NodeJS.ProcessEnv {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) return { ...process.env };
  const javaBin = join(javaHome, 'bin');
  const path = process.env.PATH ? `${javaBin}${delimiter}${process.env.PATH}` : javaBin;
  return { ...process.env, JAVA_HOME: javaHome, PATH: path };
}

/**
 * Resolve a profile-stated command into a spawn target. Mirrors runContractCommand's
 * routing: `npm`/`node`-prefixed commands route through the bundled tooling
 * (npm-cli.js / process.execPath) without a shell; every other command runs
 * verbatim through the platform shell so the stated wrapper (./gradlew, mvnw, …)
 * is honored as-is. The returned shape is the reliable runner's
 * {@link CommandTarget}.
 */
function resolveCommandTarget(command: string): CommandTarget {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/u);
  const [program] = tokens;
  if (program === 'npm' || program === 'npm.cmd') {
    const npm = npmCommand(tokens.slice(1));
    return { executable: npm.executable, args: npm.args, shell: false };
  }
  if (program === 'node' || program === 'node.exe') {
    return { executable: process.execPath, args: tokens.slice(1), shell: false };
  }
  return { executable: trimmed, args: [], shell: true };
}

/**
 * CERTIFICATION-GAMING-REMEDY M2-2 — the additive coverage report (REPORT
 * ONLY, never enforcing). Derives, from the EXACT sealed tree already
 * extracted for the runnability proof:
 *
 *   - the CANONICAL test-file universe: test files under tests/** union the
 *     test files enumerated by the sealed package.json scripts.test;
 *   - the EXECUTED set: the test files the declared testCommand runs (opaque
 *     npm-test style commands resolved through the sealed package.json of the
 *     same tree; genuinely opaque runners reported as opaque, no fabricated
 *     claims).
 *
 * The stage-11 gaming this makes visible: 9 canonical files, declaration
 * enumerating 7, the two red ones excluded — reported as
 * "executed 7 of 9; not executed: tests/renderer.test.js,
 * tests/websocket-server.test.js" while the outcome itself is unchanged.
 */
function computeTestCoverageReport(
  directory: string,
  profile: ReadinessProfile,
): { observation: Record<string, unknown>; message: string } {
  const treeTests = collectCanonicalTestFiles(directory);
  const packageTestScript = readSealedPackageJsonTestScript(directory);
  const scriptFiles = packageTestScript !== null
    ? extractTestFileTokensFromCommand(packageTestScript)
    : [];
  const canonical = [...new Set([...treeTests, ...scriptFiles])].sort();
  const declared = resolveDeclaredTestSurface({
    testCommand: profile.commands.testCommand,
    sealedPackageJsonTestScript: packageTestScript,
  });
  // A directory-shaped execution (declaration or resolved script) runs the
  // whole sealed tests/** tree.
  const executed = declared.files !== null && declared.files.length > 0
    ? declared.files
    : (declared.status === 'whole-tests-directory'
        || (declared.status === 'resolved-via-sealed-package-json'
          && declared.files !== null))
      ? treeTests
      : null;
  const notExecuted = executed === null
    ? null
    : canonical.filter(file => !executed.includes(file));
  const observation: Record<string, unknown> = {
    canonicalTestFiles: canonical,
    declaredTestCommandResolution: declared.status,
    declaredExecutedTestFiles: executed,
    notExecutedTestFiles: notExecuted,
  };
  const message = executed === null
    ? 'declared test command is opaque ('
      + truncateMiddle(profile.commands.testCommand.trim(), 80)
      + `); canonical test files in the sealed tree: ${canonical.length}`
      + (canonical.length > 0 ? ` [${formatFileList(canonical)}]` : ' (none found)')
    : `executed ${executed.length} of ${canonical.length} canonical test files`
      + ' (sealed tree tests/** universe); not executed: '
      + (notExecuted !== null && notExecuted.length > 0
        ? notExecuted.join(', ')
        : '(none)');
  return { observation, message };
}

/**
 * M1-b (step 4) — decide the EXECUTED test command under the
 * derived-canonical rule. Returns the honored declared command when the
 * declaration covers the canonical universe (or the universe is empty, or
 * the declaration is honestly opaque — the unchanged report-only boundary);
 * otherwise the gate-derived command (the declaration's own runner and
 * flags, extended with the canonical files it omitted). For an npm-style
 * declaration the shortfall is measured against the SEALED package.json
 * script's surface, and the derived command is rebuilt from that sealed
 * script (derived from the artefact, not the declaration's word).
 */
function enforceDerivedCanonicalTestSet(input: {
  readonly profile: ReadinessProfile;
  readonly canonicalFiles: readonly string[];
  readonly sealedPackageJsonTestScript: string | null;
}): {
  readonly status: 'honored' | 'gate-derived';
  readonly testCommand: string;
  readonly addedFiles: readonly string[];
} {
  const declaredCommand = input.profile.commands.testCommand;
  if (input.canonicalFiles.length === 0) {
    return { status: 'honored', testCommand: declaredCommand, addedFiles: [] };
  }
  const declared = resolveDeclaredTestSurface({
    testCommand: declaredCommand,
    sealedPackageJsonTestScript: input.sealedPackageJsonTestScript,
  });
  if (declared.status === 'unresolved-opaque') {
    return { status: 'honored', testCommand: declaredCommand, addedFiles: [] };
  }
  if (declared.status === 'declaration-enumerated') {
    const missing = input.canonicalFiles.filter(file => !declared.files!.includes(file));
    if (missing.length === 0) {
      return { status: 'honored', testCommand: declaredCommand, addedFiles: [] };
    }
    const derived = withTestFilesExtendedTo({
      command: declaredCommand,
      targetFiles: [...new Set([...declared.files!, ...input.canonicalFiles])],
    });
    return { status: 'gate-derived', testCommand: derived.command, addedFiles: derived.addedFiles };
  }
  // whole-tests-directory / resolved-via-sealed-package-json: the executed
  // surface is the sealed script's (or the tests/ tree's); measure there and
  // derive over the SEALED script's own tokens.
  const scriptCommand = input.sealedPackageJsonTestScript ?? declaredCommand;
  const scriptSurface = resolveDeclaredTestSurface({
    testCommand: scriptCommand,
    sealedPackageJsonTestScript: null,
  });
  const scriptFiles = scriptSurface.status === 'declaration-enumerated'
    ? scriptSurface.files!
    : null;
  const missing = scriptFiles === null
    ? []
    : input.canonicalFiles.filter(file => !scriptFiles.includes(file));
  if (missing.length === 0) {
    return { status: 'honored', testCommand: declaredCommand, addedFiles: [] };
  }
  const derived = withTestFilesExtendedTo({
    command: scriptCommand,
    targetFiles: [...new Set([...(scriptFiles ?? []), ...input.canonicalFiles])],
  });
  return { status: 'gate-derived', testCommand: derived.command, addedFiles: derived.addedFiles };
}

/** Test-suffixed files under the sealed tree's tests/ directory (recursive). */
function collectCanonicalTestFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(join(directory, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && isTestFilePath(child)) found.push(normalizeTestPath(child));
    }
  };
  walk('tests');
  return found.sort();
}

/** The sealed package.json's scripts.test string, or null when unreadable. */
function readSealedPackageJsonTestScript(directory: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      scripts?: { test?: unknown };
    };
    const test = parsed.scripts?.test;
    return typeof test === 'string' && test.trim() !== '' ? test : null;
  } catch {
    return null;
  }
}

function extractTestFileTokensFromCommand(command: string): string[] {
  return [...resolveDeclaredTestSurface({
    testCommand: command,
    sealedPackageJsonTestScript: null,
  }).files ?? []];
}

function formatFileList(files: readonly string[]): string {
  const shown = files.slice(0, 12).join(', ');
  return files.length > 12 ? `${shown} (+${files.length - 12} more)` : shown;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 3) / 2);
  return `${value.slice(0, half)}...${value.slice(value.length - half)}`;
}

/**
 * CC-GAP-9 / ADR-089 — the typed UNKNOWN receipt for an exhausted in-check
 * substrate retry. Never 'passed', never 'failed': the check never exercised
 * the product, so the verdict asserts exactly that. Carries:
 *
 *   - the decodable `warrant-blocked-environment` diagnostic (the frozen
 *     ADR-089 contract vocabulary) with the human-readable resume guidance;
 *   - the frozen-policy attempt evidence (per-attempt code, attempt bound,
 *     retry schedule) inside the content-addressed observation digest.
 *
 * Deliberately emits NO SeamRepairIssue: a substrate precondition is not a
 * product defect — there is no rejected material and no producing task to
 * route a repair to (ADR-089 Red Team #3; the observation-retry grammar
 * §21, not the recovery grammar §17).
 */
function substrateUnknownEvidence(
  attempts: readonly SubstrateRetryAttempt[],
  subject: CandidateSubject,
  observation: Record<string, unknown>,
  coverageMessage?: string,
  environmentMessage?: string,
): CheckProviderResult {
  const digest = sha256Hex({
    providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    candidateHash: subject.candidateHash,
    commitSha: subject.commitSha,
    treeHash: subject.treeHash,
    observation: {
      ...observation,
      ...substrateRetryObservation(attempts),
    },
  });
  const evidenceRefs = [
    `local-readiness:${digest}`,
    encodeCheckDiagnostic({
      code: SUBSTRATE_PRECONDITION_DIAGNOSTIC,
      message: substrateRetryMessage(attempts),
    }),
  ];
  // M2-2 — the additive coverage report rides this outcome too (report only).
  if (coverageMessage !== undefined) {
    evidenceRefs.push(encodeCheckDiagnostic({
      code: 'readiness-test-coverage',
      message: coverageMessage,
    }));
  }
  // K19 — the derived-environment identity rides this outcome too.
  if (environmentMessage !== undefined) {
    evidenceRefs.push(encodeCheckDiagnostic({
      code: 'environment-derivation',
      message: environmentMessage,
    }));
  }
  return { outcome: 'unknown', evidenceRefs };
}

function evidence(
  outcome: 'passed' | 'failed',
  subject: CandidateSubject,
  observation: Record<string, unknown>,
  diagnosticCode?: string,
  seamIssue?: SeamRepairIssue,
  coverageMessage?: string,
  environmentMessage?: string,
): CheckProviderResult {
  const digest = sha256Hex({
    providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    candidateHash: subject.candidateHash,
    commitSha: subject.commitSha,
    treeHash: subject.treeHash,
    observation,
  });
  const evidenceRefs = [`local-readiness:${digest}`];
  // Surface a DECODABLE diagnostic so the verifier's recovery-feedback carries
  // the actionable failure detail (compile/test output), not a bare 'failed'.
  // readCurrentProductionCellRecoveryFeedback decodes factory-check-diagnostic/v1
  // refs into issue.findings[]; a bare 'local-readiness:<hash>' ref is opaque and
  // collapses to a generic "check returned failed" message the worker cannot act on.
  // A specific diagnosticCode (e.g. LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE) from a
  // ReadinessExecutionError names the exact substrate failure; the default
  // 'local-runnability' covers command/profile failures.
  if (outcome === 'failed') {
    const reason = typeof observation.reason === 'string' && observation.reason.length > 0
      ? observation.reason
      : 'local runnability check failed';
    evidenceRefs.push(encodeCheckDiagnostic({
      code: diagnosticCode ?? 'local-runnability',
      message: reason.slice(0, 4000),
    }));
    // SEAM-ARCHITECT Layer 2 (b) — the typed seam repair-issue rides the SAME
    // evidenceRefs array (append-only, no new authority path): seamKind,
    // producingTaskRef, localization, evidence. Decoded at the points of
    // decision (recovery feedback sheet, continuation defect evidence).
    if (seamIssue !== undefined) {
      evidenceRefs.push(encodeSeamRepairIssue(seamIssue));
    }
  }
  // M2-2 — the additive coverage report rides every outcome as a DECODABLE
  // diagnostic (appended last: existing failure diagnostics keep their
  // positions). Report only: its presence never changes the outcome.
  if (coverageMessage !== undefined) {
    evidenceRefs.push(encodeCheckDiagnostic({
      code: 'readiness-test-coverage',
      message: coverageMessage,
    }));
  }
  // K19 — the derived-environment identity rides every outcome as a
  // DECODABLE diagnostic: the immutable object preparation and certification
  // share, and the derivation gap when one exists.
  if (environmentMessage !== undefined) {
    evidenceRefs.push(encodeCheckDiagnostic({
      code: 'environment-derivation',
      message: environmentMessage,
    }));
  }
  return { outcome, evidenceRefs };
}

function runNpm(args: readonly string[], cwd: string, timeout: number): void {
  const npm = npmCommand(args);
  try {
    execFileSync(npm.executable, npm.args, {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(commandFailureDetail(npm.executable, npm.args, error));
  }
}

function npmCommand(args: readonly string[]): { executable: string; args: string[] } {
  if (process.platform !== 'win32') return { executable: 'npm', args: [...args] };
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('npm cli is unavailable');
  return { executable: process.execPath, args: [npmCli, ...args] };
}

function git(repositoryPath: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Read a git object's type by its EXACT content-addressed id. `git cat-file -t`
 * resolves ONLY by object id from the object DB — it never moves a ref, reads
 * the working tree, or checks out a branch. Returns null when the object is
 * absent or unreadable so the caller can fail closed with a precise code.
 */
function readObjectType(repositoryPath: string, objectSha: string): string | null {
  try {
    return git(repositoryPath, ['cat-file', '-t', objectSha]);
  } catch {
    return null;
  }
}

/**
 * ADR-053 / LR-02 — prove the runnability subject IS the exact content-
 * addressed git object sealed in the accepted product. The authority is the
 * immutable commit SHA + tree SHA pair; a moving ref, branch tip, HEAD, or a
 * working-tree path is refused. Each object is read by identity from the
 * object DB (git cat-file), and the commit is bound to the sealed tree by
 * reading the tree id off the commit object itself. Purely read-only: never
 * checks out, advances, or mutates any ref or the canonical branch.
 */
function verifyExactObjectAuthority(
  repositoryPath: string,
  commitSha: string,
  treeHash: string,
): void {
  // The authority must be full object ids. Defense-in-depth: resolveSubject
  // already guards the sealed shape, but the authority layer refuses a moving
  // ref / tip / HEAD / branch on its own — the proof binds to an immutable
  // object, not a movable pointer.
  if (!OBJECT_ID_RE.test(commitSha) || !OBJECT_ID_RE.test(treeHash)) {
    throw new Error('LOCAL_READINESS_AUTHORITY_NOT_CONTENT_ADDRESSED');
  }
  // Read the exact objects by identity. The sealed commit and its tree must
  // both exist in the object DB with the sealed types.
  const commitType = readObjectType(repositoryPath, commitSha);
  if (commitType === null) throw new Error('LOCAL_READINESS_COMMIT_OBJECT_MISSING');
  if (commitType !== 'commit') throw new Error('LOCAL_READINESS_COMMIT_OBJECT_NOT_COMMIT');
  const treeType = readObjectType(repositoryPath, treeHash);
  if (treeType === null) throw new Error('LOCAL_READINESS_TREE_OBJECT_MISSING');
  if (treeType !== 'tree') throw new Error('LOCAL_READINESS_TREE_OBJECT_NOT_TREE');
  // Bind the commit to the sealed tree. rev-parse <sha>^{tree} reads the tree
  // id recorded inside the commit object — no checkout, no ref movement. A
  // mismatched object (the commit points elsewhere) is refused here.
  const observedTree = git(repositoryPath, ['rev-parse', `${commitSha}^{tree}`]);
  if (observedTree !== treeHash) throw new Error('LOCAL_READINESS_TREE_DRIFT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
