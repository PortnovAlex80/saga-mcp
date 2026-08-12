import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CandidateSetReaderPort } from '../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../application/ports/sql-database.js';
import type {
  CheckProvider,
  CheckProviderResult,
} from '../../process-modules/domain/workplace/gate.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../modules/development/application/candidate-check-contracts.js';
import { INTEGRATED_CANDIDATE_SCHEMA } from '../../modules/development/domain/development-schemas.js';
import type { RunnabilityCommands } from '../../modules/development/domain/development-schemas.js';

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
   * The runnability command contract stated by the accepted product (parsed but
   * NOT yet validated). Validation + the fail-closed policy live in
   * runLocalReadiness so an unstated contract yields a 'failed' readiness
   * outcome, not the 'error' sentinel reserved for subject-resolution failures.
   */
  runnability: unknown;
}

/**
 * A full git object id (SHA-1, 40 hex). The runnability authority must be a
 * content-addressed object id — NEVER a moving ref, branch name, tip, HEAD, or
 * a working-tree path. ADR-053 / LR-02.
 */
const OBJECT_ID_RE = /^[a-f0-9]{40}$/u;

const completed = new Map<string, CheckProviderResult>();

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
    run({ subjectCandidateSetRef }) {
      let subject;
      try {
        subject = resolveSubject(input, subjectCandidateSetRef);
      } catch (subjErr) {
        return 'error';
      }
      const key = sha256Hex({
        provider: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
        candidateHash: subject.candidateHash,
        commitSha: subject.commitSha,
        treeHash: subject.treeHash,
      });
      const existing = completed.get(key);
      if (existing) return existing;
      let check: CheckProviderResult;
      try {
        check = runLocalReadiness(subject);
      } catch (diagErr) {
        check = 'error';
      }
      completed.set(key, check);
      return check;
    },
  };
}

export function ensureLocalRunnabilityProviderTrust(db: SqlDatabasePort): void {
  const existing = db.prepare(
    `SELECT version,category,determinism,status
       FROM trusted_providers
      WHERE project_id IS NULL AND name=? ORDER BY id LIMIT 1`,
  ).get(LOCAL_RUNNABILITY_CHECK_PROVIDER_ID) as {
    version: string | null;
    category: string;
    determinism: string;
    status: string;
  } | undefined;
  if (existing) {
    if (existing.version !== LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION
        || existing.category !== 'deterministic_evidence'
        || existing.determinism !== 'full'
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
  const set = input.candidateSets.read(candidateSetRef);
  if (!set || set.role !== 'author') throw new Error('LOCAL_READINESS_SUBJECT_MISSING');
  const member = set.members.find(
    candidate => candidate.productRef.schemaId === INTEGRATED_CANDIDATE_SCHEMA,
  );
  if (!member) throw new Error('LOCAL_READINESS_SUBJECT_NOT_SEALED');
  const { schemaId, ref, digest } = member.productRef;
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
    repositories?: Array<{
      projectRepositoryId?: unknown;
      commitSha?: unknown;
      treeHash?: unknown;
    }>;
    // LR-03 — the deterministic install/test command contract stated by the
    // accepted product. Parsed here (part of the frozen payload); validated and
    // consumed by runLocalReadiness.
    runnability?: unknown;
  };
  if (typeof candidate.candidateHash !== 'string'
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
    candidateHash: candidate.candidateHash,
    runnability: candidate.runnability,
  };
}

function runLocalReadiness(
  subject: CandidateSubject,
): CheckProviderResult {
  const directory = mkdtempSync(join(tmpdir(), 'saga-local-readiness-'));
  const archive = join(directory, 'candidate.tar');
  const checkout = join(directory, 'checkout');
  try {
    // ADR-053 / LR-02 — read the exact sealed object by identity. The archive
    // is generated from the content-addressed commitSha verified above (whose
    // tree === subject.treeHash); it is NOT a checkout of a ref, tip, or the
    // working tree, and it never mutates the canonical branch.
    const tar = execFileSync('git', [
      '-C', subject.repositoryPath, 'archive', '--format=tar', subject.commitSha,
    ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(archive, tar);
    execFileSync('tar', ['-xf', archive, '-C', directory, '--force-local'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    // LR-03 — the install + test commands come from the accepted product
    // contract (the frozen candidate's explicit `runnability` statement), NOT
    // from guessing based on package.json / build.gradle presence. If the
    // contract cannot state its commands, fail closed rather than guessing.
    const commands = validateRunnability(subject.runnability);
    if (commands === null) {
      return evidence('failed', subject, {
        reason:
          'product contract does not state deterministic runnability commands '
          + '(runnability.testCommand missing or invalid); refusing to guess '
          + 'from incidental files',
      });
    }
    // Build-system detection is a VALIDATOR/fallback (background cb3e944): it
    // cross-checks the candidate's files and selects the execution environment
    // (JAVA_HOME/bin for JVM tooling). It is NEVER the authority for WHICH
    // commands prove runnability — that is the product contract above.
    const detected = detectBuildSystem(directory);
    const env = detected === 'gradle' || detected === 'maven'
      ? jvmEnv()
      : { ...process.env };
    // Install (deterministic, from the contract) — only when the contract
    // states an install command.
    const phases: string[] = [];
    if (commands.installCommand !== null) {
      runContractCommand(commands.installCommand, directory, env, 240_000);
      phases.push('contract-install');
    }
    // Test (deterministic, from the contract) — the runnability authority.
    runContractCommand(commands.testCommand, directory, env, 600_000);
    phases.push('contract-test');
    // Optional secondary phase: npm start + loopback probe. ADDITIVE evidence
    // only, never the command authority. Runs solely when the detected build
    // system is npm and the candidate carries an explicit `start` script; we do
    // not guess a serve task for other stacks.
    if (detected === 'npm') {
      const probeResult = tryNpmStartProbe(directory, subject);
      if (probeResult.started) {
        phases.push('npm-start', 'loopback-http-probe', 'clean-shutdown');
        return evidence('passed', subject, {
          phases,
          detectedBuildSystem: detected,
          ...probeResult.evidence,
        });
      }
    }
    return evidence('passed', subject, {
      phases,
      detectedBuildSystem: detected,
      note: 'runnability proven by the contract-stated install/test commands',
    });
  } catch (error) {
    return evidence('failed', subject, { reason: errorMessage(error) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    void checkout;
  }
}

/**
 * Validate the runnability command contract stated by the accepted product.
 * Returns the typed commands when the contract states a non-empty
 * `testCommand` (and an `installCommand` that is either null or a non-empty
 * string); returns null when the contract cannot state its commands, so the
 * caller fails closed instead of guessing.
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
 * is a VALIDATOR/fallback only (LR-03): it cross-checks the candidate's files
 * and informs execution-environment selection. The COMMANDS that prove
 * runnability come from the product contract, not from this detection.
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
    runNpm(tokens.slice(1), directory, timeoutMs);
    return;
  }
  if (program === 'node' || program === 'node.exe') {
    execFileSync(process.execPath, tokens.slice(1), {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return;
  }
  execFileSync(trimmed, {
    cwd: directory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    // Run the contract's command verbatim through the platform shell.
    shell: true,
  });
}

function jvmEnv(): NodeJS.ProcessEnv {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) return { ...process.env };
  const javaBin = join(javaHome, 'bin');
  const path = process.env.PATH ? `${javaBin}${delimiter}${process.env.PATH}` : javaBin;
  return { ...process.env, JAVA_HOME: javaHome, PATH: path };
}

function tryNpmStartProbe(
  directory: string,
  subject: CandidateSubject,
): { started: boolean; evidence?: Record<string, unknown> } {
  const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>;
  };
  if (typeof packageJson.scripts?.start !== 'string') return { started: false };
  const port = 20_000 + (Number.parseInt(subject.candidateHash.slice(0, 6), 16) % 20_000);
  const npm = npmCommand(['start']);
  const child = spawn(npm.executable, npm.args, {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BROWSER: 'none',
      CI: '1',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk).slice(0, 16_384); });
  child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 16_384); });
  try {
    probe(`http://127.0.0.1:${port}/`, child.pid, 15_000);
  } finally {
    terminateProcessTree(child.pid);
  }
  return {
    started: true,
    evidence: {
      port,
      stdoutDigest: sha256Hex(stdout),
      stderrDigest: sha256Hex(stderr),
    },
  };
}

function evidence(
  outcome: 'passed' | 'failed',
  subject: CandidateSubject,
  observation: Record<string, unknown>,
): CheckProviderResult {
  const digest = sha256Hex({
    providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    candidateHash: subject.candidateHash,
    commitSha: subject.commitSha,
    treeHash: subject.treeHash,
    observation,
  });
  return { outcome, evidenceRefs: [`local-readiness:${digest}`] };
}

function runNpm(args: readonly string[], cwd: string, timeout: number): void {
  const npm = npmCommand(args);
  execFileSync(npm.executable, npm.args, {
    cwd,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

function npmCommand(args: readonly string[]): { executable: string; args: string[] } {
  if (process.platform !== 'win32') return { executable: 'npm', args: [...args] };
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('npm cli is unavailable');
  return { executable: process.execPath, args: [npmCli, ...args] };
}

function probe(
  url: string,
  pid: number | undefined,
  timeoutMs: number,
): void {
  const script = String.raw`
const http=require('http');
const deadline=Date.now()+Number(process.argv[2]);
function attempt(){
  const req=http.get(process.argv[1],res=>{
    res.resume();
    if((res.statusCode||500)>=200&&(res.statusCode||500)<500) process.exit(0);
    setTimeout(attempt,100);
  });
  req.setTimeout(500,()=>req.destroy());
  req.on('error',()=>Date.now()<deadline?setTimeout(attempt,100):process.exit(1));
}
attempt();`;
  try {
    execFileSync(process.execPath, ['-e', script, url, String(timeoutMs)], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs + 2_000,
      windowsHide: true,
    });
  } catch {
    throw new Error(`loopback readiness probe timed out (pid=${pid ?? 'unknown'})`);
  }
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    // The process may already have exited after the successful probe.
  }
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
