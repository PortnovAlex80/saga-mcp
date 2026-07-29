/**
 * Test-only weak-model warm start.
 *
 * This adapter exposes already prepared draft files to one exact module node.
 * It does not seed database rows, mark protocol steps complete, or create
 * accepted output. The worker must still register the drafts through its
 * normal MCP tools and every kernel resolver/gate still runs.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ProcessExecutionWorkspace } from '../../process-modules/application/process-execution-workspace.js';

const SCHEMA = 'saga3.test-warm-start-fixture.v1';
const MODE = 'verify-and-submit-existing-draft' as const;

interface DraftSpec {
  readonly path: string;
  /**
   * learn: missing/empty is a cold start; later runs reuse the populated file.
   * locked: the file must exist and match sha256 exactly.
   */
  readonly policy?: 'learn' | 'locked';
  readonly sha256?: string;
}

interface NodeSpec {
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly mode: typeof MODE;
  readonly drafts: readonly DraftSpec[];
  readonly instruction?: string;
}

interface FixtureDocument {
  readonly schemaVersion: typeof SCHEMA;
  readonly fixtureId: string;
  readonly nodes: readonly NodeSpec[];
}

export interface ApplyTestWarmStartRequest {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly processWorkspace: ProcessExecutionWorkspace;
}

function containedPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`TEST_WARM_START_PATH_INVALID: '${relativePath}'`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`TEST_WARM_START_PATH_ESCAPE: '${relativePath}'`);
  }
  return resolved;
}

function parseFixture(raw: string): FixtureDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('TEST_WARM_START_FIXTURE_INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TEST_WARM_START_FIXTURE_INVALID');
  }
  const fixture = value as Partial<FixtureDocument>;
  if (
    fixture.schemaVersion !== SCHEMA
    || typeof fixture.fixtureId !== 'string'
    || fixture.fixtureId.trim() === ''
    || !Array.isArray(fixture.nodes)
  ) {
    throw new Error('TEST_WARM_START_FIXTURE_INVALID');
  }
  for (const node of fixture.nodes) {
    if (
      !node
      || typeof node !== 'object'
      || typeof node.moduleRef !== 'string'
      || typeof node.nodeId !== 'string'
      || node.mode !== MODE
      || !Array.isArray(node.drafts)
      || node.drafts.length === 0
    ) {
      throw new Error('TEST_WARM_START_NODE_INVALID');
    }
    for (const draft of node.drafts) {
      if (
        !draft
      || typeof draft !== 'object'
      || typeof draft.path !== 'string'
        || (draft.policy !== undefined
          && draft.policy !== 'learn'
          && draft.policy !== 'locked')
        || (draft.sha256 !== undefined
          && !/^[a-f0-9]{64}$/i.test(draft.sha256))
        || (draft.policy === 'locked' && draft.sha256 === undefined)
      ) {
        throw new Error('TEST_WARM_START_DRAFT_INVALID');
      }
    }
  }
  return fixture as FixtureDocument;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Apply a matching test fixture to a materialized worker workspace.
 *
 * Two-key interlock:
 * - SAGA_TEST_WARM_START=1
 * - SAGA_TEST_WARM_START_FIXTURE=<absolute JSON path>
 *
 * Supplying only one key fails closed.
 */
export function applyTestWarmStart(
  request: ApplyTestWarmStartRequest,
): ProcessExecutionWorkspace {
  const enabled = request.env.SAGA_TEST_WARM_START === '1';
  const fixturePath = request.env.SAGA_TEST_WARM_START_FIXTURE?.trim();
  if (!enabled && !fixturePath) return request.processWorkspace;
  if (!enabled || !fixturePath) {
    throw new Error('TEST_WARM_START_INTERLOCK_REQUIRED');
  }
  if (!path.isAbsolute(fixturePath) || !existsSync(fixturePath)) {
    throw new Error('TEST_WARM_START_FIXTURE_MISSING');
  }

  const fixture = parseFixture(readFileSync(fixturePath, 'utf8'));
  const matches = fixture.nodes.filter(node =>
    node.moduleRef === request.moduleRef && node.nodeId === request.nodeId,
  );
  if (matches.length === 0) return request.processWorkspace;
  if (matches.length !== 1) {
    throw new Error(
      `TEST_WARM_START_NODE_AMBIGUOUS: ${request.moduleRef}/${request.nodeId}`,
    );
  }

  const match = matches[0];
  const draftFiles: string[] = [];
  const coldStartFiles: string[] = [];
  const draftReceipts = match.drafts.map(draft => {
    const absolute = containedPath(request.workspaceRoot, draft.path);
    const relative = draft.path.replace(/\\/g, '/');
    const policy = draft.policy ?? (draft.sha256 ? 'locked' : 'learn');
    if (!existsSync(absolute)) {
      if (policy === 'locked') {
        throw new Error(`TEST_WARM_START_DRAFT_MISSING: '${draft.path}'`);
      }
      coldStartFiles.push(relative);
      return { path: relative, policy, state: 'missing' as const, sha256: null };
    }
    const bytes = readFileSync(absolute);
    const actualHash = sha256File(absolute);
    if (policy === 'locked' && actualHash !== draft.sha256!.toLowerCase()) {
      throw new Error(
        `TEST_WARM_START_DRAFT_HASH_MISMATCH: '${draft.path}'`,
      );
    }
    if (bytes.toString('utf8').trim() === '') {
      if (policy === 'locked') {
        throw new Error(`TEST_WARM_START_DRAFT_EMPTY: '${draft.path}'`);
      }
      coldStartFiles.push(relative);
      return { path: relative, policy, state: 'empty' as const, sha256: actualHash };
    }
    draftFiles.push(relative);
    return { path: relative, policy, state: 'reusable' as const, sha256: actualHash };
  });

  const executionDirectory = containedPath(
    request.workspaceRoot,
    request.processWorkspace.executionDirectory,
  );
  const receiptPath = path.join(executionDirectory, 'test-warm-start.json');
  const receipt = {
    schemaVersion: 'saga3.test-warm-start-receipt.v1',
    fixtureId: fixture.fixtureId,
    moduleRef: request.moduleRef,
    nodeId: request.nodeId,
    mode: MODE,
    drafts: draftReceipts,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const relativeReceipt = path.relative(
    path.resolve(request.workspaceRoot),
    receiptPath,
  ).replace(/\\/g, '/');

  return {
    ...request.processWorkspace,
    workspaceFiles: [
      ...request.processWorkspace.workspaceFiles,
      relativeReceipt,
      ...draftFiles.filter(file =>
        !request.processWorkspace.workspaceFiles.includes(file)),
    ],
    testWarmStart: {
      fixtureId: fixture.fixtureId,
      mode: MODE,
      nodeId: request.nodeId,
      draftFiles,
      coldStartFiles,
      instruction: match.instruction?.trim()
        || 'Reuse every available candidate draft after verifying it against the current task. Create missing or empty cold-start files normally. Make only necessary corrections, then register outputs with the normal materialized MCP calls and complete the task.',
      receiptPath: relativeReceipt,
    },
  };
}
