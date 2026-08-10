import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  SOURCE_CHANGE_CANDIDATE_SCHEMA,
  type SourceChangeCandidateInput,
  type SourceChangeEntry,
} from '../../process-modules/domain/source-change-candidate.js';

export { SOURCE_CHANGE_CANDIDATE_SCHEMA };

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(
  repositoryRoot: string,
  args: readonly string[],
  options: { input?: string; indexFile?: string } = {},
): string {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    input: options.input,
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
      GIT_AUTHOR_NAME: 'Saga Factory',
      GIT_AUTHOR_EMAIL: 'factory@local.invalid',
      GIT_COMMITTER_NAME: 'Saga Factory',
      GIT_COMMITTER_EMAIL: 'factory@local.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `SOURCE_CHANGE_GIT_FAILED: git ${args.join(' ')}: ${result.stderr?.trim() ?? ''}`,
    );
  }
  return result.stdout.trim();
}

function validatePath(candidate: string): string {
  if (
    !candidate
    || candidate.startsWith('/')
    || candidate.startsWith('\\')
    || /^[A-Za-z]:/.test(candidate)
    || candidate.includes('\\')
    || candidate.split('/').some(segment => segment === '..' || segment === '.' || !segment)
  ) {
    throw new Error(`SOURCE_CHANGE_PATH_INVALID: ${candidate}`);
  }
  if (candidate === '.git' || candidate.startsWith('.git/')) {
    throw new Error(`SOURCE_CHANGE_GIT_INTERNAL_PATH_DENIED: ${candidate}`);
  }
  return candidate;
}

function validateEntries(entries: readonly SourceChangeEntry[], scopes: readonly string[]): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('SOURCE_CHANGE_ENTRIES_REQUIRED');
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidatePath = validatePath(entry.path);
    const folded = candidatePath.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error(`SOURCE_CHANGE_PATH_DUPLICATE: ${candidatePath}`);
    seen.add(folded);
    if (!['create', 'modify', 'delete'].includes(entry.operation)) {
      throw new Error(`SOURCE_CHANGE_OPERATION_UNSUPPORTED: ${String(entry.operation)}`);
    }
    if (entry.mode !== undefined && entry.mode !== '100644') {
      throw new Error(`SOURCE_CHANGE_MODE_UNSUPPORTED: ${candidatePath}`);
    }
    if (entry.operation === 'delete') {
      if (entry.content !== undefined || entry.digest !== undefined) {
        throw new Error(`SOURCE_CHANGE_DELETE_CONTENT_FORBIDDEN: ${candidatePath}`);
      }
    } else {
      if (typeof entry.content !== 'string') {
        throw new Error(`SOURCE_CHANGE_TEXT_CONTENT_REQUIRED: ${candidatePath}`);
      }
      if (entry.content.includes('\0')) {
        throw new Error(`SOURCE_CHANGE_BINARY_CONTENT_DENIED: ${candidatePath}`);
      }
      // The Factory owns cryptographic identity. An LM may echo a digest as an
      // additional consistency check, but it is never required to calculate
      // or assert the authoritative hash itself.
      if (entry.digest !== undefined && entry.digest !== sha256(entry.content)) {
        throw new Error(
          `SOURCE_CHANGE_CONTENT_DIGEST_MISMATCH: ${candidatePath}; `
          + 'omit digest and let Factory compute the canonical SHA-256',
        );
      }
    }
    const inScope = scopes.some(scope => {
      const normalized = validatePath(scope).replace(/\/$/, '');
      return candidatePath === normalized || candidatePath.startsWith(`${normalized}/`);
    });
    if (!inScope) throw new Error(`SOURCE_CHANGE_OUT_OF_SCOPE: ${candidatePath}`);
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Convert an LM-authored textual manifest into a Factory-authored private Git
 * candidate using plumbing commands only. The model never receives a mutable
 * checkout or ref authority.
 */
export function materializeManagedSourceChange(
  db: Database.Database,
  schema: string,
  content: unknown,
): unknown {
  if (schema !== SOURCE_CHANGE_CANDIDATE_SCHEMA) return content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(
      'SOURCE_CHANGE_CANDIDATE_OBJECT_REQUIRED: pass content as a JSON object, not prose or an encoded JSON string. '
      + 'Exact shape: product_submit({schema:"factory.source-change-candidate.v1",content:{'
      + 'schemaVersion:"factory.source-change-candidate.v1",workItemKey:"<task item key>",'
      + 'baseCommit:"<frozen 40-hex commit>",entries:[{path:"index.html",operation:"modify",'
      + 'content:"<complete UTF-8 file>"}]}}). Factory computes the digest.',
    );
  }
  const candidate = content as Partial<SourceChangeCandidateInput>;
  if (
    candidate.schemaVersion !== SOURCE_CHANGE_CANDIDATE_SCHEMA
    || typeof candidate.workItemKey !== 'string'
    || !candidate.workItemKey
    || typeof candidate.baseCommit !== 'string'
    || !candidate.baseCommit
    || !Array.isArray(candidate.entries)
  ) {
    throw new Error(
      'SOURCE_CHANGE_CANDIDATE_INVALID: content requires exact fields '
      + '{schemaVersion,workItemKey,baseCommit,entries}; each create/modify entry uses '
      + '{path,operation,content}; optional digest is only a consistency check. '
      + 'Do not use body, contentHash, metadata, or an encoded JSON string.',
    );
  }
  const executionRef = process.env.SAGA_EXECUTION_ID;
  if (!executionRef) throw new Error('SOURCE_CHANGE_EXECUTION_REQUIRED');
  const context = db.prepare(
    `SELECT we.task_id,t.project_repository_id,t.metadata,
            COALESCE(rc.local_path,pr.local_path) AS repository_root,
            pr.integration_branch,r.receipt_ref,r.receipt_digest,
            r.effective_base_commit
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
       JOIN project_repositories pr ON pr.id=t.project_repository_id
       LEFT JOIN repository_checkouts rc
         ON rc.project_repository_id=pr.id AND rc.status='active'
       JOIN factory_effective_desk_base_receipts r
         ON r.execution_ref=we.execution_id AND r.task_id=t.id
      WHERE we.execution_id=?`,
  ).get(executionRef) as {
    task_id: number;
    project_repository_id: number;
    metadata: string;
    repository_root: string;
    integration_branch: string;
    receipt_ref: string;
    receipt_digest: string;
    effective_base_commit: string;
  } | undefined;
  if (!context) throw new Error('SOURCE_CHANGE_BASE_RECEIPT_REQUIRED');
  if (candidate.baseCommit !== context.effective_base_commit) {
    throw new Error(
      `SOURCE_CHANGE_BASE_MISMATCH: expected ${context.effective_base_commit}, `
      + `got ${candidate.baseCommit}`,
    );
  }
  const metadata = parseJsonRecord(context.metadata);
  const item = metadata.cell_input_item;
  const itemRecord = item && typeof item === 'object' && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
  const scopes = Array.isArray(itemRecord.changeScopes)
    ? itemRecord.changeScopes.filter((value): value is string => typeof value === 'string')
    : [];
  if (scopes.length === 0) throw new Error('SOURCE_CHANGE_SCOPE_REQUIRED');
  validateEntries(candidate.entries, scopes);

  const repositoryRoot = context.repository_root;
  const baseCommit = git(repositoryRoot, [
    'rev-parse', '--verify', `${candidate.baseCommit}^{commit}`,
  ]);
  const baseTree = git(repositoryRoot, ['rev-parse', `${baseCommit}^{tree}`]);
  const safeExecution = sha256(executionRef).slice(0, 32);
  const candidateRef = `refs/saga/candidates/${safeExecution}`;
  const indexFile = path.join(os.tmpdir(), `saga-index-${safeExecution}`);
  if (existsSync(indexFile)) rmSync(indexFile, { force: true });
  try {
    git(repositoryRoot, ['read-tree', baseCommit], { indexFile });
    for (const entry of candidate.entries) {
      if (entry.operation === 'delete') {
        git(repositoryRoot, ['update-index', '--remove', '--', entry.path], { indexFile });
        continue;
      }
      const blob = git(repositoryRoot, ['hash-object', '-w', '--stdin'], {
        input: entry.content!,
      });
      git(repositoryRoot, [
        'update-index', '--add', '--cacheinfo', `100644,${blob},${entry.path}`,
      ], { indexFile });
    }
    const tree = git(repositoryRoot, ['write-tree'], { indexFile });
    if (tree === baseTree) throw new Error('SOURCE_CHANGE_EMPTY_TREE');

    let commit: string;
    try {
      const existing = git(repositoryRoot, ['rev-parse', '--verify', `${candidateRef}^{commit}`]);
      const existingTree = git(repositoryRoot, ['rev-parse', `${existing}^{tree}`]);
      const existingParent = git(repositoryRoot, ['rev-parse', `${existing}^`]);
      if (existingTree !== tree || existingParent !== baseCommit) {
        throw new Error('SOURCE_CHANGE_EXECUTION_REF_REUSED_WITH_DIFFERENT_TREE');
      }
      commit = existing;
    } catch (error) {
      if (error instanceof Error && error.message.includes('REUSED_WITH_DIFFERENT_TREE')) throw error;
      commit = git(repositoryRoot, ['commit-tree', tree, '-p', baseCommit], {
        input: `factory: materialize ${candidate.workItemKey}\n`,
      });
      git(repositoryRoot, ['update-ref', candidateRef, commit]);
    }

    return {
      schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
      workItemKey: candidate.workItemKey,
      terminalStatus: 'complete',
      textSet: {
        baseTreeRef: baseTree,
        entries: candidate.entries.map(entry => ({
          path: entry.path,
          operation: entry.operation,
          mediaType: entry.mediaType ?? 'text/plain',
          mode: entry.mode ?? '100644',
          ...(entry.operation === 'delete'
            ? {}
            : { digest: sha256(entry.content!), content: entry.content }),
        })),
      },
      source: {
        branch: candidateRef,
        commitSha: commit,
        workItemKey: candidate.workItemKey,
      },
      snapshot: { commitSha: commit, treeSha: tree, files: candidate.entries.map(entry => entry.path) },
      repository: {
        projectRepositoryId: context.project_repository_id,
        integrationBranch: context.integration_branch,
        baseCommit,
        name: path.basename(repositoryRoot),
      },
      effectiveBaseReceipt: {
        ref: context.receipt_ref,
        digest: context.receipt_digest,
      },
      buildProducts: candidate.tests ?? [],
      reasonCodes: candidate.reasonCodes ?? [],
    };
  } finally {
    if (existsSync(indexFile)) rmSync(indexFile, { force: true });
  }
}
