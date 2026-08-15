import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  DeliveryActionProvider,
  DeliveryPreflightCheckProvider,
} from '../../modules/delivery/domain/delivery-provider-ports.js';
import type {
  AuthorizedDeliveryReleaseCase,
  DeliveryContentAddressedReference,
  ReleaseActionDefinition,
} from '../../modules/delivery/domain/delivery-schemas.js';

const PROVIDER_NAME = 'saga-local-git-release';
const PROVIDER_VERSION = '1.0.0';

export function ensureLocalGitReleaseProvider(
  db: Database.Database,
  projectId: number,
): { providerId: number; name: string; version: string; category: 'authoritative_state' } {
  db.prepare(
    `INSERT INTO trusted_providers
      (project_id,category,name,trust_basis,determinism,scope,layer,version,status)
     VALUES (?,'authoritative_state',?,?,'partial',?,'L4',?,'active')
     ON CONFLICT(project_id,name) DO UPDATE SET
       category=excluded.category,trust_basis=excluded.trust_basis,
       determinism=excluded.determinism,scope=excluded.scope,
       layer=excluded.layer,version=excluded.version,status='active'`,
  ).run(
    projectId,
    PROVIDER_NAME,
    'Factory-owned local Git ref observation with compare-and-set mutation',
    'project-local source tag and candidate Git identity',
    PROVIDER_VERSION,
  );
  const row = db.prepare(
    `SELECT id FROM trusted_providers WHERE project_id=? AND name=?`,
  ).get(projectId, PROVIDER_NAME) as { id: number };
  return {
    providerId: row.id,
    name: PROVIDER_NAME,
    version: PROVIDER_VERSION,
    category: 'authoritative_state',
  };
}

export function createLocalGitReleaseProviders(
  db: Database.Database,
  projectId: number,
): {
  preflight: DeliveryPreflightCheckProvider;
  sourceTag: DeliveryActionProvider;
  observeCurrentCandidateHash: (deliveryCase: AuthorizedDeliveryReleaseCase) => string | null;
} {
  const identity = ensureLocalGitReleaseProvider(db, projectId);
  const repository = () => resolveRepository(db, projectId);
  const evidence = (kind: string, body: unknown): DeliveryContentAddressedReference => {
    const hash = sha256Hex(body);
    return { schema: `factory.${kind}.v1`, ref: `${kind}:${hash}`, hash };
  };
  const inspectCandidate = (deliveryCase: AuthorizedDeliveryReleaseCase) => {
    const repo = repository();
    const commit = git(repo.path, 'rev-parse', `refs/heads/${repo.branch}`);
    const tree = git(repo.path, 'rev-parse', `${commit}^{tree}`);
    const expected = actionPayload(deliveryCase.policy.actions[0]!);
    return { repo, commit, tree, expected };
  };
  const preflight: DeliveryPreflightCheckProvider = {
    evaluate({ deliveryCase, checkId }) {
      const observed = inspectCandidate(deliveryCase);
      const passed = checkId === 'candidate-integrity'
        && observed.commit === observed.expected.commit
        && observed.tree === observed.expected.tree;
      const body = { checkId, candidateHash: deliveryCase.integratedCandidate.hash, ...observed };
      return {
        outcome: passed ? 'passed' : 'failed',
        evidence: evidence('local-git-preflight', body),
        provider: identity,
      };
    },
  };
  const sourceTag: DeliveryActionProvider = {
    namespace: `${PROVIDER_NAME}:${PROVIDER_VERSION}`,
    identity,
    async execute({ deliveryCase, action }) {
      const payload = actionPayload(action);
      const repo = repository();
      if (payload.repositoryId !== repo.id) {
        return { outcome: 'blocked', error: 'LOCAL_RELEASE_REPOSITORY_MISMATCH' };
      }
      assertTag(payload.tag);
      const expected = inspectCandidate(deliveryCase);
      if (expected.commit !== payload.commit || expected.tree !== payload.tree) {
        return { outcome: 'blocked', error: 'LOCAL_RELEASE_CANDIDATE_DRIFT' };
      }
      const ref = `refs/tags/${payload.tag}`;
      try {
        execFileSync('git', ['-C', repo.path, 'update-ref', ref, payload.commit, ZERO_OID], {
          stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        });
      } catch {
        const observed = observeTag(repo.path, payload.tag);
        if (observed?.commit !== payload.commit || observed.tree !== payload.tree) {
          return { outcome: 'blocked', externalRef: ref, error: 'LOCAL_RELEASE_TAG_CONFLICT' };
        }
      }
      return { outcome: 'succeeded', externalRef: ref, resultHash: action.desiredStateHash };
    },
    async observe({ action }) {
      const payload = actionPayload(action);
      const repo = repository();
      if (payload.repositoryId !== repo.id) {
        const body = { expectedRepositoryId: repo.id, requestedRepositoryId: payload.repositoryId };
        return {
          outcome: 'mismatched', observedStateHash: sha256Hex(body),
          observation: evidence('local-git-tag-observation', body),
        };
      }
      assertTag(payload.tag);
      const observed = observeTag(repo.path, payload.tag);
      const matched = observed?.commit === payload.commit && observed.tree === payload.tree;
      const body = { repositoryId: repo.id, tag: payload.tag, ...observed, matched };
      return {
        outcome: matched ? 'matched' : 'mismatched',
        observedStateHash: matched ? action.desiredStateHash : sha256Hex(body),
        observation: evidence('local-git-tag-observation', body),
      };
    },
  };
  return {
    preflight,
    sourceTag,
    observeCurrentCandidateHash(deliveryCase) {
      try {
        const observed = inspectCandidate(deliveryCase);
        return observed.commit === observed.expected.commit && observed.tree === observed.expected.tree
          ? deliveryCase.integratedCandidate.hash
          : null;
      } catch { return null; }
    },
  };
}

const ZERO_OID = '0000000000000000000000000000000000000000';
function actionPayload(action: ReleaseActionDefinition): { repositoryId: number; tag: string; commit: string; tree: string } {
  const [repositoryId, tag, commit, tree] = action.target.split('|');
  if (!repositoryId || !tag || !commit || !tree || action.kind !== 'source-tag') {
    throw new Error('LOCAL_RELEASE_ACTION_INVALID');
  }
  return { repositoryId: Number(repositoryId.replace('project-repository:', '')), tag, commit, tree };
}
function assertTag(tag: string): void {
  try { execFileSync('git', ['check-ref-format', `refs/tags/${tag}`], { stdio: 'ignore' }); }
  catch { throw new Error('LOCAL_RELEASE_TAG_INVALID'); }
}
function observeTag(path: string, tag: string): { commit: string; tree: string } | null {
  try {
    const commit = git(path, 'rev-parse', `refs/tags/${tag}^{commit}`);
    return { commit, tree: git(path, 'rev-parse', `${commit}^{tree}`) };
  } catch { return null; }
}
function resolveRepository(db: Database.Database, projectId: number): { id: number; path: string; branch: string } {
  const rows = db.prepare(
    `SELECT id,local_path,integration_branch FROM project_repositories
      WHERE project_id=? AND status='active' ORDER BY id`,
  ).all(projectId) as Array<{ id: number; local_path: string | null; integration_branch: string }>;
  if (rows.length !== 1 || !rows[0]!.local_path) throw new Error('LOCAL_RELEASE_REPOSITORY_NOT_EXACT');
  return { id: rows[0]!.id, path: rows[0]!.local_path!, branch: rows[0]!.integration_branch };
}
function git(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  }).trim();
}
