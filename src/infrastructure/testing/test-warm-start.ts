/**
 * Test-only, epic-scoped draft learning cache.
 *
 * The cache is an infrastructure sidecar. It never writes tracker DB rows,
 * marks protocol steps complete, or bypasses module resolvers and gates.
 * Each module node owns a logical slot under one epic cache. Before a worker
 * starts, a cached draft is restored into that execution's exact target path.
 * After the worker exits (successfully or not), the target is captured back.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ProcessExecutionWorkspace } from '../../process-modules/application/process-execution-workspace.js';

const SCHEMA = 'saga3.test-warm-start-fixture.v1';
const CACHE_SCHEMA = 'saga3.test-draft-cache-entry.v1';
const MODE = 'verify-and-submit-existing-draft' as const;

interface DraftSpec {
  readonly slot?: string;
  /** Stable project-relative target, used by canonical module documents. */
  readonly path?: string;
  /**
   * Basename of one file already materialized for the current execution.
   * This is the safe dynamic-path mechanism; no glob or latest-execution scan.
   */
  readonly workspaceFile?: string;
  /** Optional project-relative first-run seed. */
  readonly seedPath?: string;
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
  readonly epicId?: number;
  readonly nodes: readonly NodeSpec[];
}

interface CacheMetadata {
  readonly schemaVersion: typeof CACHE_SCHEMA;
  readonly fixtureId: string;
  readonly epicId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly slot: string;
  readonly contentHash: string;
  readonly lastOutcome: TestWarmStartCaptureOutcome;
  readonly repeatedFailureCount: number;
  readonly packageDigest: string | null;
  readonly inputHash: string | null;
  readonly updatedAt: string;
}

export type TestWarmStartCaptureOutcome =
  | 'completed'
  | 'changes_requested'
  | 'failed';

export interface ApplyTestWarmStartRequest {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly epicId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly packageDigest?: string | null;
  readonly inputHash?: string | null;
  readonly processWorkspace: ProcessExecutionWorkspace;
}

function safeSegment(value: string, label: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`TEST_WARM_START_${label}_INVALID`);
  }
  return safe;
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

function relativePath(root: string, absolutePath: string): string {
  return path.relative(path.resolve(root), absolutePath).replace(/\\/g, '/');
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
    || (fixture.epicId !== undefined
      && (!Number.isSafeInteger(fixture.epicId) || fixture.epicId < 1))
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
    const slots = new Set<string>();
    for (const draft of node.drafts) {
      const hasPath = typeof draft?.path === 'string' && draft.path.length > 0;
      const hasWorkspaceFile = typeof draft?.workspaceFile === 'string'
        && draft.workspaceFile.length > 0;
      const slot = draft?.slot
        ?? (hasPath ? path.posix.basename(draft.path!) : draft?.workspaceFile);
      if (
        !draft
        || typeof draft !== 'object'
        || hasPath === hasWorkspaceFile
        || typeof slot !== 'string'
        || slot.length === 0
        || slots.has(slot)
        || (draft.seedPath !== undefined && typeof draft.seedPath !== 'string')
        || (draft.policy !== undefined
          && draft.policy !== 'learn'
          && draft.policy !== 'locked')
        || (draft.sha256 !== undefined
          && !/^[a-f0-9]{64}$/i.test(draft.sha256))
        || (draft.policy === 'locked' && draft.sha256 === undefined)
      ) {
        throw new Error('TEST_WARM_START_DRAFT_INVALID');
      }
      slots.add(slot);
    }
  }
  return fixture as FixtureDocument;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function nonEmptyBytes(filePath: string): Uint8Array | null {
  if (!existsSync(filePath)) return null;
  const bytes = readFileSync(filePath);
  return bytes.toString('utf8').trim() === '' ? null : bytes;
}

function readMetadata(metadataPath: string): CacheMetadata | null {
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as CacheMetadata;
    return parsed?.schemaVersion === CACHE_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

function resolveTarget(
  workspaceRoot: string,
  processWorkspace: ProcessExecutionWorkspace,
  draft: DraftSpec,
): { absolute: string; relative: string } {
  if (draft.path) {
    const absolute = containedPath(workspaceRoot, draft.path);
    return { absolute, relative: relativePath(workspaceRoot, absolute) };
  }
  const basename = draft.workspaceFile!;
  if (basename !== path.basename(basename)) {
    throw new Error(`TEST_WARM_START_WORKSPACE_SLOT_INVALID: '${basename}'`);
  }
  const matches = processWorkspace.workspaceFiles.filter(candidate =>
    path.posix.basename(candidate) === basename,
  );
  if (matches.length !== 1) {
    throw new Error(
      `TEST_WARM_START_WORKSPACE_SLOT_${matches.length === 0 ? 'MISSING' : 'AMBIGUOUS'}: '${basename}'`,
    );
  }
  const absolute = containedPath(workspaceRoot, matches[0]);
  return { absolute, relative: relativePath(workspaceRoot, absolute) };
}

function cachePaths(
  workspaceRoot: string,
  epicId: number,
  moduleRef: string,
  nodeId: string,
  slot: string,
  targetPath: string,
): { root: string; content: string; metadata: string } {
  const root = path.join(
    path.resolve(workspaceRoot),
    '.saga',
    'test-draft-cache',
    'epics',
    String(epicId),
    safeSegment(moduleRef, 'MODULE_REF'),
    safeSegment(nodeId, 'NODE_ID'),
  );
  const extension = path.extname(targetPath) || '.draft';
  const base = safeSegment(slot, 'SLOT');
  return {
    root,
    content: path.join(root, `${base}${extension}`),
    metadata: path.join(root, `${base}.json`),
  };
}

function writeCacheContent(
  cacheContentPath: string,
  bytes: Uint8Array,
): void {
  mkdirSync(path.dirname(cacheContentPath), { recursive: true });
  writeFileSync(cacheContentPath, bytes);
}

/**
 * Restores the epic-scoped source into the current execution target.
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
  if (!Number.isSafeInteger(request.epicId) || request.epicId < 1) {
    throw new Error('TEST_WARM_START_EPIC_INVALID');
  }
  if (!path.isAbsolute(fixturePath) || !existsSync(fixturePath)) {
    throw new Error('TEST_WARM_START_FIXTURE_MISSING');
  }

  const fixture = parseFixture(readFileSync(fixturePath, 'utf8'));
  if (fixture.epicId !== undefined && fixture.epicId !== request.epicId) {
    return request.processWorkspace;
  }
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
  const forceRewriteSlots: string[] = [];
  const cacheEntries: NonNullable<
    ProcessExecutionWorkspace['testWarmStart']
  >['cacheEntries'][number][] = [];
  let cacheRoot: string | null = null;

  const draftReceipts = match.drafts.map(draft => {
    const target = resolveTarget(
      request.workspaceRoot,
      request.processWorkspace,
      draft,
    );
    const slot = draft.slot
      ?? (draft.path ? path.posix.basename(draft.path) : draft.workspaceFile!);
    const policy = draft.policy ?? (draft.sha256 ? 'locked' : 'learn');
    const paths = cachePaths(
      request.workspaceRoot,
      request.epicId,
      request.moduleRef,
      request.nodeId,
      slot,
      target.relative,
    );
    cacheRoot ??= paths.root;

    if (policy === 'locked') {
      const bytes = nonEmptyBytes(target.absolute);
      if (!bytes) {
        throw new Error(`TEST_WARM_START_DRAFT_MISSING_OR_EMPTY: '${target.relative}'`);
      }
      const actualHash = sha256Bytes(bytes);
      if (actualHash !== draft.sha256!.toLowerCase()) {
        throw new Error(`TEST_WARM_START_DRAFT_HASH_MISMATCH: '${target.relative}'`);
      }
      draftFiles.push(target.relative);
      cacheEntries.push({
        slot,
        policy,
        targetPath: target.relative,
        cachePath: null,
        metadataPath: null,
        packageDigest: request.packageDigest ?? null,
        inputHash: request.inputHash ?? null,
      });
      return {
        slot,
        targetPath: target.relative,
        policy,
        state: 'locked',
        sha256: actualHash,
      };
    }

    mkdirSync(paths.root, { recursive: true });
    let source = nonEmptyBytes(paths.content);
    let sourceState = source ? 'epic-cache' : 'cold-start';
    if (!source && draft.seedPath) {
      const seed = containedPath(request.workspaceRoot, draft.seedPath);
      source = nonEmptyBytes(seed);
      if (source) {
        writeCacheContent(paths.content, source);
        sourceState = 'fixture-seed';
      }
    }

    const priorMetadata = readMetadata(paths.metadata);
    if (source) {
      mkdirSync(path.dirname(target.absolute), { recursive: true });
      writeFileSync(target.absolute, source);
      draftFiles.push(target.relative);
      if ((priorMetadata?.repeatedFailureCount ?? 0) >= 2) {
        forceRewriteSlots.push(slot);
      }
    } else {
      coldStartFiles.push(target.relative);
    }

    cacheEntries.push({
      slot,
      policy,
      targetPath: target.relative,
      cachePath: relativePath(request.workspaceRoot, paths.content),
      metadataPath: relativePath(request.workspaceRoot, paths.metadata),
      packageDigest: request.packageDigest ?? null,
      inputHash: request.inputHash ?? null,
    });
    return {
      slot,
      targetPath: target.relative,
      cachePath: relativePath(request.workspaceRoot, paths.content),
      policy,
      state: sourceState,
      sha256: source ? sha256Bytes(source) : null,
      previousOutcome: priorMetadata?.lastOutcome ?? null,
      repeatedFailureCount: priorMetadata?.repeatedFailureCount ?? 0,
      producerPackageDigest: priorMetadata?.packageDigest ?? null,
      producerInputHash: priorMetadata?.inputHash ?? null,
    };
  });

  const executionDirectory = containedPath(
    request.workspaceRoot,
    request.processWorkspace.executionDirectory,
  );
  const receiptPath = path.join(executionDirectory, 'test-warm-start.json');
  const receipt = {
    schemaVersion: 'saga3.test-warm-start-receipt.v2',
    fixtureId: fixture.fixtureId,
    epicId: request.epicId,
    moduleRef: request.moduleRef,
    nodeId: request.nodeId,
    packageDigest: request.packageDigest ?? null,
    inputHash: request.inputHash ?? null,
    mode: MODE,
    cacheRoot: relativePath(request.workspaceRoot, cacheRoot!),
    drafts: draftReceipts,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const relativeReceipt = relativePath(request.workspaceRoot, receiptPath);

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
      forceRewriteSlots,
      instruction: match.instruction?.trim()
        || 'Reuse available epic drafts after verifying them against the current task. Create cold-start files normally. Register outputs with the normal MCP calls and complete the task.',
      receiptPath: relativeReceipt,
      cacheRoot: relativePath(request.workspaceRoot, cacheRoot!),
      cacheEntries,
    },
  };
}

/**
 * Captures every learn-mode slot after the worker exits. Interrupted and
 * rejected drafts are retained with their outcome so the next attempt can
 * repair them using normal recovery feedback.
 */
export function captureTestWarmStart(
  workspaceRoot: string,
  processWorkspace: ProcessExecutionWorkspace | null,
  outcome: TestWarmStartCaptureOutcome,
): void {
  const warm = processWorkspace?.testWarmStart;
  if (!warm) return;

  for (const entry of warm.cacheEntries) {
    if (
      entry.policy !== 'learn'
      || !entry.cachePath
      || !entry.metadataPath
    ) continue;
    const target = containedPath(workspaceRoot, entry.targetPath);
    const bytes = nonEmptyBytes(target);
    if (!bytes) continue;

    const cacheContent = containedPath(workspaceRoot, entry.cachePath);
    const metadataPath = containedPath(workspaceRoot, entry.metadataPath);
    const contentHash = sha256Bytes(bytes);
    const previous = readMetadata(metadataPath);
    const repeatedFailureCount = outcome === 'completed'
      ? 0
      : previous
        && previous.lastOutcome !== 'completed'
        && previous.contentHash === contentHash
        ? previous.repeatedFailureCount + 1
        : 1;

    const previousBytes = nonEmptyBytes(cacheContent);
    if (previousBytes && sha256Bytes(previousBytes) !== contentHash) {
      const historyDirectory = path.join(path.dirname(cacheContent), 'history');
      mkdirSync(historyDirectory, { recursive: true });
      writeFileSync(
        path.join(
          historyDirectory,
          `${safeSegment(entry.slot, 'SLOT')}-${sha256Bytes(previousBytes)}${path.extname(cacheContent)}`,
        ),
        previousBytes,
      );
    }
    writeCacheContent(cacheContent, bytes);
    const metadata: CacheMetadata = {
      schemaVersion: CACHE_SCHEMA,
      fixtureId: warm.fixtureId,
      epicId: Number(
        entry.cachePath.match(/(?:^|\/)epics\/(\d+)(?:\/|$)/)?.[1] ?? 0,
      ),
      moduleRef: processWorkspace.moduleRef,
      nodeId: warm.nodeId,
      slot: entry.slot,
      contentHash,
      lastOutcome: outcome,
      repeatedFailureCount,
      packageDigest: entry.packageDigest,
      inputHash: entry.inputHash,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }
}
