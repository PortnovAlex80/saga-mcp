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
import { encodeCheckDiagnostic } from '../../process-modules/domain/workplace/check-diagnostic.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../modules/development/application/candidate-check-contracts.js';

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
}

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
  const set = input.candidateSets.read(candidateSetRef);
  if (!set || set.role !== 'author') throw new Error('LOCAL_READINESS_SUBJECT_MISSING');
  const product = input.db.prepare(
    `SELECT payload_snapshot
       FROM factory_process_products
      WHERE process_run_id=? AND product_kind='development.integrated-candidate'`,
  ).get(set.workplaceRef.processRunId) as { payload_snapshot: string } | undefined;
  if (!product) throw new Error('LOCAL_READINESS_CANDIDATE_MISSING');
  const candidate = JSON.parse(product.payload_snapshot) as {
    candidateHash?: unknown;
    repositories?: Array<{
      projectRepositoryId?: unknown;
      commitSha?: unknown;
      treeHash?: unknown;
    }>;
  };
  if (typeof candidate.candidateHash !== 'string'
      || !Array.isArray(candidate.repositories)
      || candidate.repositories.length !== 1) {
    throw new Error('LOCAL_READINESS_CANDIDATE_INVALID');
  }
  const repository = candidate.repositories[0]!;
  if (!Number.isSafeInteger(repository.projectRepositoryId)
      || typeof repository.commitSha !== 'string'
      || !/^[a-f0-9]{40}$/u.test(repository.commitSha)
      || typeof repository.treeHash !== 'string'
      || !/^[a-f0-9]{40}$/u.test(repository.treeHash)) {
    throw new Error('LOCAL_READINESS_REPOSITORY_INVALID');
  }
  const binding = input.db.prepare(
    'SELECT local_path FROM project_repositories WHERE id=?',
  ).get(repository.projectRepositoryId) as { local_path: string | null } | undefined;
  if (!binding?.local_path) throw new Error('LOCAL_READINESS_REPOSITORY_MISSING');
  const observedTree = git(binding.local_path, ['rev-parse', `${repository.commitSha}^{tree}`]);
  if (observedTree !== repository.treeHash) throw new Error('LOCAL_READINESS_TREE_DRIFT');
  return {
    repositoryPath: binding.local_path,
    commitSha: repository.commitSha,
    treeHash: repository.treeHash,
    candidateHash: candidate.candidateHash,
  };
}

function runLocalReadiness(
  subject: CandidateSubject,
): CheckProviderResult {
  const directory = mkdtempSync(join(tmpdir(), 'saga-local-readiness-'));
  const archive = join(directory, 'candidate.tar');
  const checkout = join(directory, 'checkout');
  try {
    const tar = execFileSync('git', [
      '-C', subject.repositoryPath, 'archive', '--format=tar', subject.commitSha,
    ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(archive, tar);
    execFileSync('tar', ['-xf', archive, '-C', directory, '--force-local'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    // UNIVERSAL ENGINE: the architect chooses the language/stack; the engine
    // detects the build system from the files the worker produced and runs that
    // system's native test command. The gate must NOT hardcode npm.
    const system = detectBuildSystem(directory);
    if (!system) {
      return evidence('failed', subject, {
        reason: 'no supported build system found in candidate (expected build.gradle[.kts], pom.xml, or package.json)',
      });
    }
    runSystemTest(system, directory);
    // Start + loopback HTTP probe is opt-in and only generically detectable for
    // npm (explicit scripts.start). For other systems the runnability proof is
    // the passing native test command; framework-specific serve tasks are not
    // reliably detectable, so we do not guess.
    if (system === 'npm') {
      const probeResult = tryNpmStartProbe(directory, subject);
      if (probeResult.started) {
        return evidence('passed', subject, {
          phases: ['npm-test', 'npm-start', 'loopback-http-probe', 'clean-shutdown'],
          ...probeResult.evidence,
        });
      }
      return evidence('passed', subject, {
        phases: ['npm-test'],
        note: 'no "start" script; runnability proven by npm test only',
      });
    }
    return evidence('passed', subject, {
      phases: [`${system}-test`],
      note: `${system} runnability proven by native test task`,
    });
  } catch (error) {
    return evidence('failed', subject, { reason: errorMessage(error) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    void checkout;
  }
}

/**
 * Detect the candidate's build system from the files the worker produced. The
 * architect owns the stack choice; the gate honors it by file presence.
 */
function detectBuildSystem(directory: string): 'gradle' | 'maven' | 'npm' | null {
  if (existsSync(join(directory, 'build.gradle.kts'))
      || existsSync(join(directory, 'build.gradle'))) return 'gradle';
  if (existsSync(join(directory, 'pom.xml'))) return 'maven';
  if (existsSync(join(directory, 'package.json'))) return 'npm';
  return null;
}

/**
 * Run the detected build system's native test command. JVM systems get
 * JAVA_HOME/bin on PATH so the gradle/maven wrappers find java even when it is
 * not on the global PATH. Cold JVM builds (distribution + dependency download)
 * get a generous timeout.
 */
function runSystemTest(system: 'gradle' | 'maven' | 'npm', directory: string): void {
  if (system === 'npm') {
    runNpmTest(directory);
    return;
  }
  const env = jvmEnv();
  if (system === 'gradle') {
    runBuild(wrapCommand(directory, 'gradlew', 'gradle'), ['test', '--no-daemon'], directory, env, 600_000);
    return;
  }
  // maven
  runBuild(wrapCommand(directory, 'mvnw', 'mvn'), ['test', '-B', '-q'], directory, env, 600_000);
}

function runNpmTest(directory: string): void {
  const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>;
  } & DependencyGroups;
  if (typeof packageJson.scripts?.test !== 'string') {
    throw new Error('required npm script "test" is missing');
  }
  if (hasDependencySpecifiers(packageJson)) {
    runNpm(['install', '--no-audit', '--no-fund'], directory, 240_000);
  }
  runNpm(['test'], directory, 120_000);
}

/**
 * Resolve a build-tool wrapper: prefer the committed wrapper
 * (gradlew/mvnw[.bat]), fall back to the global tool. Returns the executable
 * name; on Windows the wrapper is a .bat and must run through cmd (shell:true
 * in runBuild).
 */
function wrapCommand(directory: string, wrapperBase: string, globalTool: string): string {
  const isWin = process.platform === 'win32';
  const wrapperName = isWin ? `${wrapperBase}.bat` : wrapperBase;
  return existsSync(join(directory, wrapperName)) ? wrapperName : globalTool;
}

function runBuild(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): void {
  try {
    execFileSync(executable, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      // Windows wrapper scripts are .bat files — they need a shell to execute.
      shell: process.platform === 'win32',
    });
  } catch (error) {
    throw new Error(commandFailureDetail(executable, args, error));
  }
}

/**
 * Build a readable failure detail from a child-process error, preserving the
 * command's stderr/stdout (compiler errors, test failures) so the verifier's
 * recovery-feedback actually tells the worker WHAT broke — not just that it did.
 */
function commandFailureDetail(
  executable: string,
  args: readonly string[],
  error: unknown,
): string {
  const e = error as { stdout?: unknown; stderr?: unknown; message?: string; code?: unknown };
  const cmd = `${executable} ${(args || []).join(' ')}`.trim();
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const tail = (s: string): string => s.slice(-3000);
  const timedOut = e.code === 'ETIMEDOUT';
  const parts = [
    timedOut ? `command timed out (${cmd})` : `command failed (${cmd})`,
    stderr ? `--- stderr ---\n${tail(stderr)}` : '',
    !stderr && stdout ? `--- stdout ---\n${tail(stdout)}` : '',
  ].filter(Boolean);
  const detail = parts.join('\n');
  return detail || (e.message ?? 'command failed');
}

function jvmEnv(): NodeJS.ProcessEnv {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) return { ...process.env };
  const javaBin = join(javaHome, 'bin');
  const path = process.env.PATH ? `${javaBin}${delimiter}${process.env.PATH}` : javaBin;
  return { ...process.env, JAVA_HOME: javaHome, PATH: path };
}

interface DependencyGroups {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
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
  const evidenceRefs = [`local-readiness:${digest}`];
  // Surface a DECODABLE diagnostic so the verifier's recovery-feedback carries
  // the actionable failure detail (compile/test output), not a bare 'failed'.
  // readCurrentProductionCellRecoveryFeedback decodes factory-check-diagnostic/v1
  // refs into issue.findings[]; a bare 'local-readiness:<hash>' ref is opaque and
  // collapses to a generic "check returned failed" message the worker cannot act on.
  if (outcome === 'failed') {
    const reason = typeof observation.reason === 'string' && observation.reason.length > 0
      ? observation.reason
      : 'local runnability check failed';
    evidenceRefs.push(encodeCheckDiagnostic({
      code: 'local-runnability',
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

function hasDependencySpecifiers(packageJson: {
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
}): boolean {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const group = packageJson[key];
    if (group && typeof group === 'object' && Object.keys(group as Record<string, unknown>).length > 0) {
      return true;
    }
  }
  return false;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
