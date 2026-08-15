import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { sha256Hex } from '../../shared/canonical-json.js';
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
import { DockerReadinessExecutor } from './docker-readiness-executor.js';

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
}): CheckProvider {
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
      const replayed = readPersistedReadinessReceipt(input.db, subjectCandidateSetRef);
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
        check = runLocalReadiness(subject);
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
      return check;
    },
  };
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
 * The lookup keys on subject_candidate_set_ref + provider_id + provider_digest
 * (the receipt table already indexes subject_candidate_set_ref). Because a
 * sealed CandidateSet is immutable, the same ref always resolves to the same
 * sealed product / git object, so a prior receipt for this ref IS the prior
 * decision for this exact subject. The provider_digest filter ensures a
 * swapped implementation (different digest) does not replay a stale receipt.
 */
function readPersistedReadinessReceipt(
  db: SqlDatabasePort,
  subjectCandidateSetRef: string,
): CheckProviderResult | null {
  let rows;
  try {
    rows = db.prepare(
      `SELECT outcome, evidence_refs
         FROM factory_check_receipts
        WHERE subject_candidate_set_ref=?
          AND provider_id=?
          AND provider_digest=?
          AND outcome IN ('passed','failed')
        ORDER BY check_receipt_ref`,
    ).all(
      subjectCandidateSetRef,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    ) as Array<{ outcome: string; evidence_refs: string }>;
  } catch {
    // The table is absent (e.g. a minimal in-memory test schema that did not
    // create the Gate receipt substrate). In production the table always exists
    // (schema.ts). Treat the missing table as "no persisted receipt" and
    // proceed to run the check.
    return null;
  }
  if (rows.length === 0) return null;
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
    // 1.1 added opt-in Docker; 1.2 adds ephemeral venv isolation. Both are
    // substrate-only changes; the versioned CheckPlan still pins exact code.
    const trustworthyBaseline = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.3.1'].includes(existing.version ?? '')
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
  subject: CandidateSubject,
): CheckProviderResult {
  const directory = mkdtempSync(join(tmpdir(), 'saga-local-readiness-'));
  const archive = join(directory, 'candidate.tar');
  let executor: ReadinessExecutor | null = null;
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
      });
    }
    // Phase-1 dockerization — select the execution substrate from the profile.
    // The COMMAND AUTHORITY is the frozen profile; the executor decides WHERE
    // (host or docker). When the profile declares environment.image, the docker
    // executor is selected (unless SAGA_LOCAL_RUNNABILITY_EXEC=host forces the
    // host path). When docker is declared but unavailable, the executor throws
    // LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE → caught below → 'failed' (NOT
    // 'error', which would retry indefinitely).
    executor = selectReadinessExecutor(directory, archive, profile, subject);
    const phases: string[] = [];
    // Install (deterministic, from the profile) — only when stated.
    if (profile.commands.installCommand !== null) {
      executor.runCommand(profile.commands.installCommand, 240_000);
      phases.push('profile-install');
    }
    // Test (deterministic, from the profile) — the runnability authority.
    executor.runCommand(profile.commands.testCommand, 600_000);
    phases.push('profile-test');
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
      const serveEvidence = executor.runServed(profile.serve.startCommand, 15_000, port);
      phases.push('profile-serve', 'loopback-http-probe', 'clean-shutdown');
      return evidence('passed', subject, {
        phases,
        readinessKind: 'served',
        ...substrateEvidence,
        ...serveEvidence,
      });
    }
    return evidence('passed', subject, {
      phases,
      readinessKind: 'static',
      ...substrateEvidence,
      note: 'runnability proven by the profile-stated install/test commands',
    });
  } catch (error) {
    // A ReadinessExecutionError carries a specific diagnostic code (e.g.
    // LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE) that the evidence function encodes
    // into a decodable check-diagnostic so the verifier's recovery feedback
    // names the exact substrate failure.
    const code = error instanceof ReadinessExecutionError ? error.code : undefined;
    return evidence('failed', subject, { reason: errorMessage(error) }, code);
  } finally {
    // Release substrate resources (docker volumes) before removing the temp
    // directory. Best-effort: a dispose failure must not mask the real result.
    try { executor?.dispose(); } catch { /* best-effort cleanup */ }
    rmSync(directory, { recursive: true, force: true });
  }
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
 * When docker is selected but the daemon is unavailable, the DockerReadinessExecutor
 * throws LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE on first use (inside runLocalReadiness's
 * try block) so the outcome is 'failed' (fail closed), NOT 'error'.
 */
function selectReadinessExecutor(
  directory: string,
  archivePath: string,
  profile: ReadinessProfile,
  subject: CandidateSubject,
): ReadinessExecutor {
  const mode = (process.env.SAGA_LOCAL_RUNNABILITY_EXEC ?? 'auto').toLowerCase();
  const declaredImage = profile.environment?.image;
  if (mode === 'host') {
    return new HostReadinessExecutor(directory, profile);
  }
  if (declaredImage !== undefined) {
    return new DockerReadinessExecutor(archivePath, declaredImage, subject.candidateHash);
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
  if (value.kind === 'static') {
    return environment
      ? { kind: 'static', commands, environment }
      : { kind: 'static', commands };
  }
  if (value.kind === 'served') {
    const serve = value.serve;
    if (serve === null || typeof serve !== 'object') return null;
    const startCommand = (serve as { startCommand?: unknown }).startCommand;
    if (typeof startCommand !== 'string' || startCommand.trim() === '') return null;
    return environment
      ? { kind: 'served', commands, serve: { startCommand }, environment }
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
    try {
      runNpm(tokens.slice(1), directory, timeoutMs);
    } catch (error) {
      throw new Error(commandFailureDetail('npm', tokens.slice(1), error));
    }
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

function evidence(
  outcome: 'passed' | 'failed',
  subject: CandidateSubject,
  observation: Record<string, unknown>,
  diagnosticCode?: string,
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
