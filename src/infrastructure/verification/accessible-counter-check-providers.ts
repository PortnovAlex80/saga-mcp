import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import type Database from 'better-sqlite3';
import type { CandidateSetReaderPort } from '../../application/ports/candidate-set-reader.js';
import type { CheckProvider } from '../../process-modules/domain/workplace/gate.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import {
  ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST,
  ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID,
  ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION,
  AUTHORIZED_OBSERVER_CHECK_PROVIDER_DIGEST,
  AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID,
  AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION,
} from '../../modules/development/application/candidate-check-contracts.js';

export function installAccessibleCounterCheckProviders(
  db: Database.Database,
  candidateSets: CandidateSetReaderPort,
): readonly CheckProvider[] {
  ensureProvider(db, ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID, 'deterministic_evidence', 'full');
  ensureProvider(db, AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID, 'authorized_decision', 'none');
  return [
    createAccessibleCounterCheckProvider(db, candidateSets),
    createAuthorizedObserverCheckProvider(db, candidateSets),
  ];
}

function createAccessibleCounterCheckProvider(
  db: Database.Database,
  candidateSets: CandidateSetReaderPort,
): CheckProvider {
  return {
    providerId: ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID,
    version: ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION,
    providerDigest: ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef }) {
      try {
        const subject = resolveSubject(db, candidateSets, subjectCandidateSetRef);
        const files = readCandidateFiles(db, subject.processRunId);
        const result = evaluateAccessibleCounterFixture(subject.criterionCode, files);
        const digest = sha256Hex({
          provider: ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST,
          candidateHash: subject.candidateHash,
          criterionCode: subject.criterionCode,
          result,
        });
        return {
          outcome: result.passed ? 'passed' : 'failed',
          evidenceRefs: [`candidate-check:${digest}`],
        };
      } catch {
        return 'error';
      }
    },
  };
}

function createAuthorizedObserverCheckProvider(
  db: Database.Database,
  candidateSets: CandidateSetReaderPort,
): CheckProvider {
  return {
    providerId: AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID,
    version: AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION,
    providerDigest: AUTHORIZED_OBSERVER_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef }) {
      try {
        const subject = resolveSubject(db, candidateSets, subjectCandidateSetRef);
        const row = db.prepare(
          `SELECT observation_ref,evidence_digest
             FROM factory_authorized_verification_observations
            WHERE candidate_hash=? AND method_plan_hash=?
              AND criterion_code=? AND verdict='passed'
            ORDER BY observed_at DESC LIMIT 1`,
        ).get(subject.candidateHash, subject.methodPlanHash, subject.criterionCode) as {
          observation_ref: string;
          evidence_digest: string;
        } | undefined;
        return row ? {
          outcome: 'passed',
          evidenceRefs: [`${row.observation_ref}@${row.evidence_digest}`],
        } : 'unknown';
      } catch {
        return 'error';
      }
    },
  };
}

function resolveSubject(
  db: Database.Database,
  candidateSets: CandidateSetReaderPort,
  candidateSetRef: string,
): { processRunId: number; criterionCode: string; candidateHash: string; methodPlanHash: string } {
  const set = candidateSets.read(candidateSetRef);
  if (!set || set.role !== 'author') throw new Error('candidate missing');
  const row = db.prepare(
    `SELECT t.metadata,a.code
       FROM tasks t
       JOIN artifacts a ON a.id=t.verification_target_artifact_id
      WHERE t.workplace_ref=?`,
  ).get(serializeWorkplaceRef(set.workplaceRef)) as { metadata: string; code: string | null } | undefined;
  if (!row?.code) throw new Error('criterion missing');
  const metadata = JSON.parse(row.metadata) as {
    process_node_input?: { upstream?: { bindings?: { candidate?: { candidateHash?: unknown } } } };
  };
  const candidateHash = metadata.process_node_input?.upstream?.bindings
    ?.candidate?.candidateHash;
  if (typeof candidateHash !== 'string' || candidateHash.length !== 64) {
    throw new Error('candidate hash missing');
  }
  const methodPlanHash = (metadata.process_node_input?.upstream?.bindings as {
    verificationMethodPlan?: { planHash?: unknown };
  } | undefined)?.verificationMethodPlan?.planHash;
  if (typeof methodPlanHash !== 'string' || methodPlanHash.length !== 64) {
    throw new Error('method plan hash missing');
  }
  return {
    processRunId: set.workplaceRef.processRunId,
    criterionCode: row.code,
    candidateHash,
    methodPlanHash,
  };
}

function readCandidateFiles(db: Database.Database, processRunId: number) {
  const row = db.prepare(
    `SELECT payload_snapshot FROM factory_process_products
      WHERE process_run_id=? AND product_kind='development.integrated-candidate'`,
  ).get(processRunId) as { payload_snapshot: string } | undefined;
  if (!row) throw new Error('candidate product missing');
  const candidate = JSON.parse(row.payload_snapshot) as {
    repositories?: Array<{ projectRepositoryId: number; commitSha: string }>;
  };
  if (candidate.repositories?.length !== 1) throw new Error('repository not exact');
  const repository = candidate.repositories[0]!;
  const binding = db.prepare(
    `SELECT local_path FROM project_repositories WHERE id=?`,
  ).get(repository.projectRepositoryId) as { local_path: string | null } | undefined;
  if (!binding?.local_path) throw new Error('repository path missing');
  return {
    html: gitShow(binding.local_path, repository.commitSha, 'index.html'),
    css: gitShow(binding.local_path, repository.commitSha, 'css/styles.css'),
    js: gitShow(binding.local_path, repository.commitSha, 'js/app.js'),
  };
}

export function evaluateAccessibleCounterFixture(
  code: string,
  files: { html: string; css: string; js: string },
) {
  const storage = new Map<string, string>();
  const first = execute(files.js, storage, false);
  const checks: Record<string, () => boolean> = {
    'AC-1': () => { first.click('increment-btn'); return first.value() === '1' && storage.get('accessible-counter-value') === '1'; },
    'AC-2': () => { first.click('decrement-btn'); return first.value() === '-1'; },
    'AC-3': () => { first.click('increment-btn'); first.click('reset-btn'); return first.value() === '0' && storage.get('accessible-counter-value') === '0'; },
    'AC-4': () => { first.click('increment-btn'); return first.value() === '1'; },
    'AC-5': () => first.key('increment-btn', 'Enter') === '1'
      && /button[^>]+id="increment-btn"/u.test(files.html)
      && /:focus|:focus-visible/u.test(files.css),
    'AC-6': () => /aria-live="polite"/u.test(files.html)
      && /aria-atomic="true"/u.test(files.html)
      && ['increment-btn', 'decrement-btn', 'reset-btn'].every(id =>
        new RegExp(`id="${id}"[^>]+aria-label=`, 'u').test(files.html)),
    'AC-7': () => { first.click('increment-btn'); return execute(files.js, storage, false).value() === '1'; },
    'AC-8': () => { const broken = execute(files.js, new Map(), true); broken.click('increment-btn'); return broken.value() === '1' && broken.notificationVisible(); },
  };
  const passed = checks[code]?.() ?? false;
  return { passed, code, fileDigests: {
    html: digest(files.html), css: digest(files.css), js: digest(files.js),
  } };
}

function execute(source: string, backing: Map<string, string>, storageThrows: boolean) {
  class Element {
    textContent = '';
    listeners = new Map<string, Array<(event: any) => void>>();
    classes = new Set<string>();
    classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
    };
    addEventListener(name: string, fn: (event: any) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    }
    click() { for (const fn of this.listeners.get('click') ?? []) fn({}); }
    key(value: string) {
      for (const fn of this.listeners.get('keydown') ?? []) {
        fn({ key: value, preventDefault() {} });
      }
    }
  }
  const elements = new Map([
    'counter-display', 'increment-btn', 'decrement-btn', 'reset-btn', 'notification-area',
  ].map(id => [id, new Element()]));
  elements.get('counter-display')!.textContent = '0';
  elements.get('notification-area')!.classes.add('hidden');
  const localStorage = {
    setItem(key: string, value: string) {
      if (storageThrows) throw new Error('disabled');
      backing.set(key, value);
    },
    getItem(key: string) {
      if (storageThrows) throw new Error('disabled');
      return backing.get(key) ?? null;
    },
    removeItem(key: string) {
      if (storageThrows) throw new Error('disabled');
      backing.delete(key);
    },
  };
  vm.runInNewContext(source, {
    document: {
      readyState: 'complete',
      getElementById: (id: string) => elements.get(id) ?? null,
      addEventListener() {},
    },
    localStorage,
    console: { warn() {} },
    setTimeout: (fn: () => void) => { fn(); return 1; },
  }, { timeout: 1_000 });
  return {
    click(id: string) { elements.get(id)!.click(); },
    key(id: string, key: string) { elements.get(id)!.key(key); return String(elements.get('counter-display')!.textContent); },
    value() { return String(elements.get('counter-display')!.textContent); },
    notificationVisible() { return !elements.get('notification-area')!.classes.has('hidden'); },
  };
}

function ensureProvider(
  db: Database.Database,
  name: string,
  category: 'deterministic_evidence' | 'authorized_decision',
  determinism: 'full' | 'none',
) {
  const existing = db.prepare(
    `SELECT id,version,category,determinism,status FROM trusted_providers
      WHERE project_id IS NULL AND name=? ORDER BY id LIMIT 1`,
  ).get(name) as {
    version: string | null;
    category: string;
    determinism: string;
    status: string;
  } | undefined;
  if (existing) {
    if (existing.version !== '1.0.0' || existing.category !== category
        || existing.determinism !== determinism || existing.status !== 'active') {
      throw new Error(`TRUSTED_PROVIDER_POLICY_DRIFT:${name}`);
    }
    return;
  }
  db.prepare(
    `INSERT INTO trusted_providers
      (project_id,name,version,category,trust_basis,determinism,scope,status)
     VALUES (NULL,?,?,?,?,?,'verification-only-continuation','active')`,
  ).run(name, '1.0.0', category, 'versioned built-in provider installation', determinism);
}

function gitShow(repositoryPath: string, commit: string, path: string) {
  return execFileSync('git', ['-C', repositoryPath, 'show', `${commit}:${path}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
