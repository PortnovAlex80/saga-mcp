import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    // git archive extracts at directory root. Keep a stable logical checkout
    // name only in evidence; commands run from that isolated root.
    const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof packageJson.scripts?.test !== 'string'
        || typeof packageJson.scripts?.start !== 'string') {
      return evidence('failed', subject, {
        reason: 'required npm scripts test/start are missing',
      });
    }
    runNpm(['test'], directory, 120_000);
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
    return evidence('passed', subject, {
      phases: ['npm-test', 'npm-start', 'loopback-http-probe', 'clean-shutdown'],
      port,
      stdoutDigest: sha256Hex(stdout),
      stderrDigest: sha256Hex(stderr),
    });
  } catch (error) {
    return evidence('failed', subject, { reason: errorMessage(error) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    void checkout;
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
