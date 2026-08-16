import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../schema.js';
import type { NodeExecutionResult } from '../process-modules/application/node-executor.js';
import { canonicalJson, digestJson, sha256 } from './canonical-json.js';
import { sha256Hex } from '../shared/canonical-json.js';
import { readArtifactStorageKind } from '../modules/shared/artifact-storage-kind.js';
import { SqliteResumeDirectiveRepository } from './sqlite-resume-directive-repository.js';
import { withBusyRetry } from '../runtime/busy-retry.js';

export interface CheckpointObject {
  readonly kind: 'database' | 'artifact' | 'worker_log';
  readonly digest: string;
  readonly size: number;
  readonly objectPath: string;
  readonly bindingId: number | null;
  readonly relativePath: string | null;
  readonly sourceRef: string;
  readonly partial: boolean;
}

export interface CapturedNodeResult {
  readonly nodeRunId: number;
  readonly processRunId: number;
  readonly nodeId: string;
  readonly packageDigest: string | null;
  readonly processInputHash: string;
  readonly result: NodeExecutionResult;
}

export interface FactoryCheckpointPayload {
  readonly format: 'saga.factory-checkpoint/v1';
  readonly checkpointRef: string;
  readonly sequence: number;
  readonly parentCheckpointRef: string | null;
  readonly sourceDbNamespace: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly scope: {
    projectId: number;
    epicId: number | null;
    lifecycleRunId: number | null;
    lifecycleInputHash: string | null;
  };
  readonly cursor: Record<string, unknown> | null;
  readonly repositories: readonly RepositoryState[];
  readonly objects: readonly CheckpointObject[];
  readonly reusableNodeResults: readonly CapturedNodeResult[];
  readonly warmStartNodes: readonly WarmStartNode[];
  readonly security: {
    logsIncluded: boolean;
    credentialsIncluded: false;
    signatureKeyId: string | null;
  };
}

export interface WarmStartNode {
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly drafts: readonly {
    slot: string;
    path: string;
    policy: 'locked';
    sha256: string;
  }[];
}

export interface FactoryCheckpointManifest {
  readonly payload: FactoryCheckpointPayload;
  readonly digest: string;
  readonly signature: string | null;
}

interface RepositoryState {
  readonly bindingId: number;
  readonly localName: string;
  readonly head: string | null;
  readonly status: string | null;
}

export interface CaptureCheckpointOptions {
  dbPath: string;
  storageRoot: string;
  projectId: number;
  epicId?: number | null;
  createdBy: string;
  includeLogs?: boolean;
  hmacKey?: string;
  signatureKeyId?: string;
}

export interface AdoptCheckpointOptions {
  dbPath: string;
  manifestPath: string;
  targetProjectId: number;
  targetEpicId: number | null;
  targetProcessRunId: number;
  targetNodeId: string;
  sourceNodeRunId: number;
  actor: string;
  reason: string;
  hmacKey?: string;
  trustLocalRegistry?: boolean;
  verificationProfile?: 'full' | 'test_replay';
}

export class FactoryCheckpointService {
  async capture(options: CaptureCheckpointOptions): Promise<FactoryCheckpointManifest> {
    const dbPath = realpathSync(options.dbPath);
    const storageRoot = path.resolve(options.storageRoot);
    mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(storageRoot, 'objects', 'sha256'), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(storageRoot, 'manifests'), { recursive: true, mode: 0o700 });

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    // Antifreeze B3: this connection is an IN-PROCESS contender of the
    // engine's main connection (capture runs inside the engine cycle). The
    // old busy_timeout=5000 meant every write collision busy-spun the shared
    // main thread for up to 5s; with an async lock holder in the same process
    // that spin is eternal (TB-2 class). Short window + bounded retry on
    // every write below; a failed capture is already non-fatal upstream
    // (orchestrate-cli logs "checkpoint not published" and continues).
    db.pragma('busy_timeout = 250');
    withBusyRetry(() => db.exec(SCHEMA_SQL), { db, attempts: 6, maxWaitMs: 5_000 });
    try {
      this.assertScope(db, options.projectId, options.epicId ?? null);
      const sourceDbNamespace = withBusyRetry(
        () => this.ensureDatabaseIdentity(db),
        { db, attempts: 6, maxWaitMs: 5_000 },
      );
      const sequence = this.nextSequence(db, options.projectId, options.epicId ?? null);
      const parent = this.latestCheckpointRef(db, options.projectId, options.epicId ?? null);
      const checkpointRef = `checkpoint-${options.projectId}-${options.epicId ?? 'all'}-${sequence}-${randomUUID()}`;
      const tempDb = path.join(storageRoot, `.capture-${randomUUID()}.db`);
      await db.backup(tempDb);
      this.verifyDatabase(tempDb);
      const objects: CheckpointObject[] = [];
      objects.push(this.putObject(storageRoot, tempDb, {
        kind: 'database', bindingId: null, relativePath: null,
        sourceRef: 'online-sqlite-backup', partial: false,
      }));

      // Open the backup readonly and read ALL manifest metadata from it —
      // NOT from the live db. The backup froze a consistent snapshot at the
      // moment of `db.backup(tempDb)`; reading from the live db afterwards
      // would let a concurrent writer create artifacts / advance the
      // lifecycle cursor / record productions that are NOT in the backup,
      // producing an internally contradictory checkpoint (database.db = T1,
      // manifest = T2). Every read below uses `snapshotDb`.
      const snapshotDb = new Database(tempDb, { readonly: true });
      try {
        const repositories = this.readRepositoryStates(snapshotDb, options.projectId);
        for (const artifact of this.readArtifactFiles(
          snapshotDb, options.projectId, options.epicId ?? null,
        )) {
          if (artifact.kind === 'db_native') {
            // db-native artifact: content is in the SQLite snapshot (artifacts
            // row), no file object is captured. Integrity is proven against the
            // canonical JSON of metadata.content, not file bytes.
            const canonical = canonicalJson(artifact.canonicalContent);
            const digest = sha256Hex(artifact.canonicalContent);
            if (artifact.expectedHash && digest !== artifact.expectedHash) {
              throw new Error(`CHECKPOINT_ARTIFACT_DB_CONTENT_HASH_MISMATCH: artifact ${artifact.artifactId}`);
            }
            const relativeObjectPath = path.join(
              'objects', 'sha256', digest.slice(0, 2), digest,
            );
            const absoluteObjectPath = containedPath(storageRoot, relativeObjectPath);
            mkdirSync(path.dirname(absoluteObjectPath), { recursive: true, mode: 0o700 });
            if (!existsSync(absoluteObjectPath)) {
              writeFileSync(absoluteObjectPath, canonical, { mode: 0o600 });
            }
            objects.push({
              kind: 'artifact',
              digest,
              size: Buffer.byteLength(canonical),
              objectPath: relativeObjectPath.replaceAll('\\', '/'),
              bindingId: null,
              relativePath: null,
              sourceRef: `artifact:${artifact.artifactId}`,
              partial: false,
            });
            continue;
          }
          // file_backed artifact: capture physical bytes, verify against DB hash.
          const captured = this.putObject(storageRoot, artifact.absolutePath, {
            kind: 'artifact',
            bindingId: artifact.bindingId,
            relativePath: artifact.relativePath,
            sourceRef: `artifact:${artifact.artifactId}`,
            partial: false,
          });
          if (artifact.expectedHash && captured.digest !== artifact.expectedHash) {
            throw new Error(`CHECKPOINT_ARTIFACT_DB_HASH_MISMATCH: artifact ${artifact.artifactId}`);
          }
          if (sha256(readFileSync(artifact.absolutePath)) !== captured.digest) {
            throw new Error(`CHECKPOINT_ARTIFACT_DRIFT_DURING_CAPTURE: artifact ${artifact.artifactId}`);
          }
          objects.push(captured);
        }
        if (options.includeLogs) {
          for (const log of this.readLogFiles(snapshotDb, options.projectId, options.epicId ?? null)) {
            objects.push(this.putObject(storageRoot, log.path, {
              kind: 'worker_log', bindingId: null, relativePath: null,
              sourceRef: `execution:${log.executionId}`, partial: true,
            }));
          }
        }

        // Rehash every stored object before publication. This is the cross-store
        // capture fence: a changing source never becomes a COMPLETE checkpoint.
        for (const object of objects) this.verifyObject(storageRoot, object);
        const lifecycle = this.readLifecycleCursor(snapshotDb, options.projectId, options.epicId ?? null);
        const payload: FactoryCheckpointPayload = {
          format: 'saga.factory-checkpoint/v1',
          checkpointRef,
          sequence,
          parentCheckpointRef: parent,
          sourceDbNamespace,
          createdAt: new Date().toISOString(),
          createdBy: options.createdBy,
          scope: {
            projectId: options.projectId,
            epicId: options.epicId ?? null,
            lifecycleRunId: lifecycle?.lifecycleRunId ?? null,
            lifecycleInputHash: lifecycle?.inputHash ?? null,
          },
          cursor: lifecycle?.cursor ?? null,
          repositories,
          objects,
          reusableNodeResults: this.readReusableNodeResults(
            snapshotDb, options.projectId, options.epicId ?? null,
          ),
          warmStartNodes: this.readWarmStartNodes(
            snapshotDb, options.projectId, options.epicId ?? null, objects,
          ),
          security: {
          logsIncluded: options.includeLogs === true,
          credentialsIncluded: false,
          signatureKeyId: options.hmacKey ? (options.signatureKeyId ?? 'local') : null,
        },
      };
      const digest = digestJson(payload);
      const signature = options.hmacKey
        ? createHmac('sha256', options.hmacKey).update(digest).digest('hex')
        : null;
      const manifest: FactoryCheckpointManifest = { payload, digest, signature };
      const manifestPath = path.join(storageRoot, 'manifests', `${checkpointRef}.json`);
      this.atomicWrite(manifestPath, `${canonicalJson(manifest)}\n`);
      this.atomicWrite(`${manifestPath}.COMPLETE`, `${digest}\n`);

      withBusyRetry(() => db.prepare(
        `INSERT INTO factory_checkpoints
          (checkpoint_ref, manifest_digest, project_id, epic_id,
           lifecycle_run_id, lifecycle_input_hash, parent_checkpoint_ref,
           sequence_no, storage_root, manifest_json, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?)`,
      ).run(
        checkpointRef, digest, options.projectId, options.epicId ?? null,
        payload.scope.lifecycleRunId, payload.scope.lifecycleInputHash, parent,
        sequence, storageRoot, canonicalJson(manifest), options.createdBy,
      ), { db, attempts: 6, maxWaitMs: 5_000 });
      this.atomicWrite(
        path.join(storageRoot, `latest-${options.projectId}-${options.epicId ?? 'all'}`),
        `${checkpointRef}\n`,
      );
      // ADR-075 housekeeping — checkpoint retention. Every engine cycle writes
      // a FULL database backup object; content addressing never deduplicates
      // them (the DB digest changes every cycle), so an unattended run with
      // autonomous recovery retries would fill the disk in hours. Keep the
      // newest MANIFESTS_TO_KEEP manifests per (project, epic) and delete the
      // older manifest files plus any object files that become unreferenced
      // across ALL remaining manifests in the store. Failure to prune is
      // logged and non-fatal — capture must never fail on housekeeping.
      try {
        withBusyRetry(
          () => this.pruneRetentionPolicy(
            db, storageRoot, options.projectId, options.epicId ?? null,
          ),
          { db, attempts: 6, maxWaitMs: 5_000 },
        );
      } catch (error) {
        console.warn(
          `[checkpoint] retention prune skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return manifest;
      } finally {
        // Close the snapshot readonly handle and remove the backup file only
        // after the manifest is fully assembled from it. Until this point the
        // backup is the source of truth for every manifest field.
        snapshotDb.close();
        rmSync(tempDb, { force: true });
      }
    } finally {
      db.close();
    }
  }

  /** Newest manifests kept per (project, epic) scope by pruneRetentionPolicy. */
  private static readonly MANIFESTS_TO_KEEP = 10;

  /**
   * ADR-075 housekeeping — checkpoint retention. Every engine cycle captures a
   * FULL database backup object; content addressing never deduplicates them
   * (the DB digest changes every cycle), so an unattended run with autonomous
   * recovery retries would fill the disk in hours. Keep the newest
   * MANIFESTS_TO_KEEP manifests of the scope, delete the older manifest files
   * (the DB rows stay — audit history is not storage), and garbage-collect
   * object files that no remaining manifest in the store references. Best
   * effort: any failure is logged by the caller and never fails capture.
   */
  private pruneRetentionPolicy(
    db: Database.Database,
    storageRoot: string,
    projectId: number,
    epicId: number | null,
  ): void {
    const stale = db.prepare(
      `SELECT checkpoint_ref FROM factory_checkpoints
         WHERE project_id=? AND epic_id IS ?
         ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
    ).all(
      projectId,
      epicId,
      FactoryCheckpointService.MANIFESTS_TO_KEEP,
    ) as Array<{ checkpoint_ref: string }>;
    if (stale.length === 0) return;
    const manifestsDir = path.join(storageRoot, 'manifests');
    for (const row of stale) {
      const manifestPath = path.join(manifestsDir, `${row.checkpoint_ref}.json`);
      rmSync(manifestPath, { force: true });
      rmSync(`${manifestPath}.COMPLETE`, { force: true });
    }
    // Garbage-collect unreferenced objects across ALL remaining manifests.
    const referenced = new Set<string>();
    let remaining = 0;
    for (const entry of readdirSync(manifestsDir)) {
      if (!entry.endsWith('.json')) continue;
      remaining += 1;
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(manifestsDir, entry), 'utf8'),
        ) as FactoryCheckpointManifest;
        for (const object of manifest.payload.objects) {
          referenced.add(object.digest);
        }
      } catch {
        // An unreadable manifest keeps its objects alive — safe side.
      }
    }
    if (remaining === 0) return;
    const objectsRoot = path.join(storageRoot, 'objects', 'sha256');
    for (const prefix of existsSync(objectsRoot) ? readdirSync(objectsRoot) : []) {
      const prefixDir = path.join(objectsRoot, prefix);
      if (!statSync(prefixDir).isDirectory()) continue;
      for (const digest of readdirSync(prefixDir)) {
        if (!referenced.has(digest)) {
          rmSync(path.join(prefixDir, digest), { force: true });
        }
      }
    }
  }

  verify(manifestPath: string, hmacKey?: string): FactoryCheckpointManifest {
    const resolved = path.resolve(manifestPath);
    if (!existsSync(`${resolved}.COMPLETE`)) {
      throw new Error('CHECKPOINT_INCOMPLETE: COMPLETE marker is missing');
    }
    const manifest = JSON.parse(readFileSync(resolved, 'utf8')) as FactoryCheckpointManifest;
    if (manifest.payload.format !== 'saga.factory-checkpoint/v1') {
      throw new Error('CHECKPOINT_FORMAT_UNSUPPORTED');
    }
    const digest = digestJson(manifest.payload);
    if (digest !== manifest.digest) throw new Error('CHECKPOINT_MANIFEST_DIGEST_MISMATCH');
    if (readFileSync(`${resolved}.COMPLETE`, 'utf8').trim() !== digest) {
      throw new Error('CHECKPOINT_COMPLETE_MARKER_MISMATCH');
    }
    if (manifest.signature) {
      if (!hmacKey) throw new Error('CHECKPOINT_SIGNATURE_KEY_REQUIRED');
      const actual = createHmac('sha256', hmacKey).update(digest).digest('hex');
      if (!safeEqual(actual, manifest.signature)) throw new Error('CHECKPOINT_SIGNATURE_INVALID');
    }
    const storageRoot = path.dirname(path.dirname(resolved));
    for (const object of manifest.payload.objects) this.verifyObject(storageRoot, object);
    const dbObject = manifest.payload.objects.find(object => object.kind === 'database');
    if (!dbObject) throw new Error('CHECKPOINT_DATABASE_OBJECT_MISSING');
    this.verifyDatabase(this.objectAbsolutePath(storageRoot, dbObject));
    return manifest;
  }

  createWarmStartFixture(manifest: FactoryCheckpointManifest): unknown {
    if (manifest.payload.scope.epicId === null) {
      throw new Error('CHECKPOINT_WARM_START_REQUIRES_EPIC_SCOPE');
    }
    return {
      schemaVersion: 'factory.test-warm-start-fixture.v1',
      fixtureId: `checkpoint:${manifest.payload.checkpointRef}`,
      epicId: manifest.payload.scope.epicId,
      nodes: manifest.payload.warmStartNodes.map(node => ({
        moduleRef: node.moduleRef,
        nodeId: node.nodeId,
        mode: 'verify-and-submit-existing-draft',
        drafts: node.drafts,
        instruction: 'Verify the supplied checkpoint drafts against the current node input and recovery feedback. Use the normal allowed MCP tools to register products; do not claim acceptance yourself.',
      })),
    };
  }

  restoreClone(params: {
    manifestPath: string;
    targetDbPath: string;
    targetWorkspace: string;
    hmacKey?: string;
  }): void {
    const manifest = this.verify(params.manifestPath, params.hmacKey);
    const targetDb = path.resolve(params.targetDbPath);
    const workspace = path.resolve(params.targetWorkspace);
    if (existsSync(targetDb) || existsSync(workspace)) {
      throw new Error('CHECKPOINT_RESTORE_TARGET_EXISTS');
    }
    mkdirSync(path.dirname(targetDb), { recursive: true });
    mkdirSync(workspace, { recursive: false, mode: 0o700 });
    const storageRoot = path.dirname(path.dirname(path.resolve(params.manifestPath)));
    const dbObject = manifest.payload.objects.find(object => object.kind === 'database');
    if (!dbObject) throw new Error('CHECKPOINT_DATABASE_OBJECT_MISSING');
    copyFileSync(this.objectAbsolutePath(storageRoot, dbObject), targetDb);
    for (const object of manifest.payload.objects.filter(o => o.kind === 'artifact')) {
      if (object.bindingId === null || object.relativePath === null) continue;
      const bindingRoot = path.join(workspace, `repository-${object.bindingId}`);
      mkdirSync(bindingRoot, { recursive: true });
      const destination = containedPath(bindingRoot, object.relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(this.objectAbsolutePath(storageRoot, object), destination);
      if (sha256(readFileSync(destination)) !== object.digest) {
        throw new Error(`CHECKPOINT_RESTORE_HASH_MISMATCH: ${object.sourceRef}`);
      }
    }
    this.verifyDatabase(targetDb);
    const cloneDb = new Database(targetDb);
    cloneDb.pragma('foreign_keys = ON');
    try {
      cloneDb.exec(SCHEMA_SQL);
      cloneDb.transaction(() => {
        cloneDb.prepare('DELETE FROM factory_database_identity WHERE singleton_id=1').run();
        cloneDb.prepare(
          'INSERT INTO factory_database_identity (singleton_id, namespace_id) VALUES (1, ?)',
        ).run(randomUUID());
        for (const repository of manifest.payload.repositories) {
          const cloneRoot = path.join(workspace, `repository-${repository.bindingId}`);
          mkdirSync(cloneRoot, { recursive: true });
          cloneDb.prepare(
            'UPDATE project_repositories SET local_path=?, updated_at=datetime(\'now\') WHERE id=?',
          ).run(cloneRoot, repository.bindingId);
        }
        cloneDb.prepare('UPDATE worker_executions SET log_path=NULL').run();
        cloneDb.prepare(
          `INSERT OR REPLACE INTO factory_runtime_mode
            (singleton_id, mode, source_checkpoint_ref, source_manifest_digest)
           VALUES (1, 'diagnostic_clone', ?, ?)`,
        ).run(manifest.payload.checkpointRef, manifest.digest);
      })();
    } finally { cloneDb.close(); }
  }

  adopt(options: AdoptCheckpointOptions): { adoptionRef: string; directiveRef: string } {
    const manifest = this.verify(options.manifestPath, options.hmacKey);
    const db = new Database(options.dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA_SQL);
    try {
      const trusted = options.trustLocalRegistry === true && Boolean(db.prepare(
        `SELECT 1 FROM factory_checkpoints
          WHERE checkpoint_ref=? AND manifest_digest=? AND status='complete'`,
      ).get(manifest.payload.checkpointRef, manifest.digest));
      if (!trusted && !manifest.signature) {
        throw new Error('CHECKPOINT_UNTRUSTED: use a signed manifest or trusted local registry');
      }
      const verificationProfile = options.verificationProfile ?? 'full';
      if (verificationProfile === 'test_replay') {
        const diagnosticClone = db.prepare(
          "SELECT 1 FROM factory_runtime_mode WHERE singleton_id=1 AND mode='diagnostic_clone'",
        ).get();
        if (!diagnosticClone) {
          throw new Error('CHECKPOINT_TEST_REPLAY_REQUIRES_DIAGNOSTIC_CLONE');
        }
      }
      if (
        manifest.payload.scope.projectId !== options.targetProjectId
        || manifest.payload.scope.epicId !== options.targetEpicId
      ) throw new Error('CHECKPOINT_SCOPE_MISMATCH');
      const run = db.prepare(
        `SELECT project_id, epic_id, input_hash, package_digest
           FROM factory_process_runs WHERE id=?`,
      ).get(options.targetProcessRunId) as {
        project_id: number; epic_id: number | null; input_hash: string;
        package_digest: string | null;
      } | undefined;
      if (!run) throw new Error('CHECKPOINT_TARGET_PROCESS_RUN_NOT_FOUND');
      if (run.project_id !== options.targetProjectId || run.epic_id !== options.targetEpicId) {
        throw new Error('CHECKPOINT_TARGET_PROCESS_SCOPE_MISMATCH');
      }
      const source = manifest.payload.reusableNodeResults.find(
        result => result.nodeRunId === options.sourceNodeRunId
          && result.nodeId === options.targetNodeId,
      );
      if (!source) throw new Error('CHECKPOINT_SOURCE_NODE_RESULT_NOT_FOUND');
      if (source.processInputHash !== run.input_hash) throw new Error('CHECKPOINT_INPUT_MISMATCH');
      if (source.packageDigest && source.packageDigest !== run.package_digest) {
        throw new Error('CHECKPOINT_PACKAGE_MISMATCH');
      }
      const existing = db.prepare(
        `SELECT a.adoption_ref, d.directive_ref
           FROM factory_adoptions a
           JOIN factory_resume_directives d ON d.adoption_ref=a.adoption_ref
          WHERE a.checkpoint_ref=? AND a.target_process_run_id=?
            AND a.target_node_id=? AND a.source_node_run_id=?`,
      ).get(
        manifest.payload.checkpointRef,
        options.targetProcessRunId,
        options.targetNodeId,
        options.sourceNodeRunId,
      ) as { adoption_ref: string; directive_ref: string } | undefined;
      if (existing) {
        return {
          adoptionRef: existing.adoption_ref,
          directiveRef: existing.directive_ref,
        };
      }
      this.materializeArtifactsForAdoption(db, manifest, options.manifestPath);
      const adoptionRef = `adoption-${randomUUID()}`;
      const directiveRef = `resume-directive-${randomUUID()}`;
      const serialized = SqliteResumeDirectiveRepository.serializeResult(source.result);
      const receipt = {
        authorityKind: 'checkpoint_import', checkpointRef: manifest.payload.checkpointRef,
        manifestDigest: manifest.digest, sourceNodeRunId: source.nodeRunId,
        targetProcessRunId: options.targetProcessRunId, targetNodeId: options.targetNodeId,
        actor: options.actor, reason: options.reason,
      };
      db.transaction(() => {
        db.prepare(
          `INSERT INTO factory_adoptions
            (adoption_ref, checkpoint_ref, manifest_digest, target_project_id,
             target_epic_id, target_process_run_id, target_node_id,
             source_node_run_id, target_input_hash, authority_kind,
             verification_profile, actor,
             reason, receipt_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'checkpoint_import', ?, ?, ?, ?)`,
        ).run(
          adoptionRef, manifest.payload.checkpointRef, manifest.digest,
          options.targetProjectId, options.targetEpicId, options.targetProcessRunId,
          options.targetNodeId, source.nodeRunId, run.input_hash, verificationProfile,
          options.actor,
          options.reason, canonicalJson(receipt),
        );
        db.prepare(
          `INSERT INTO factory_resume_directives
            (directive_ref, adoption_ref, process_run_id, node_id,
             process_input_hash, package_digest, result_json, result_digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          directiveRef, adoptionRef, options.targetProcessRunId, options.targetNodeId,
          run.input_hash, run.package_digest, serialized.json, serialized.digest,
        );
      })();
      return { adoptionRef, directiveRef };
    } finally {
      db.close();
    }
  }

  private materializeArtifactsForAdoption(
    db: Database.Database,
    manifest: FactoryCheckpointManifest,
    manifestPath: string,
  ): void {
    const roots = new Map<number, string>();
    const rows = db.prepare(
      `SELECT id, local_path FROM project_repositories
        WHERE project_id=? AND status='active'`,
    ).all(manifest.payload.scope.projectId) as Array<{ id: number; local_path: string | null }>;
    for (const row of rows) if (row.local_path) roots.set(row.id, realpathSync(row.local_path));
    const storageRoot = path.dirname(path.dirname(path.resolve(manifestPath)));
    for (const object of manifest.payload.objects.filter(o => o.kind === 'artifact')) {
      if (object.bindingId === null || object.relativePath === null) continue;
      const root = roots.get(object.bindingId);
      if (!root) throw new Error(`CHECKPOINT_REPOSITORY_BINDING_MISSING: ${object.bindingId}`);
      const destination = containedPath(root, object.relativePath);
      if (existsSync(destination)) {
        if (sha256(readFileSync(destination)) !== object.digest) {
          throw new Error(`CHECKPOINT_ADOPT_DESTINATION_CONFLICT: ${object.relativePath}`);
        }
        continue;
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(this.objectAbsolutePath(storageRoot, object), destination);
    }
  }

  private readArtifactFiles(db: Database.Database, projectId: number, epicId: number | null): Array<
    | { kind: 'file_backed'; artifactId: number; bindingId: number; relativePath: string; absolutePath: string; expectedHash: string | null }
    | { kind: 'db_native'; artifactId: number; canonicalContent: unknown; expectedHash: string | null }
  > {
    const rows = db.prepare(
      `SELECT a.id, a.path, a.content_hash, a.storage_kind, a.metadata,
              a.project_repository_id, pr.local_path
         FROM artifacts a
         LEFT JOIN project_repositories pr ON pr.id=a.project_repository_id
        WHERE a.project_id=? AND (? IS NULL OR a.epic_id=?)`,
    ).all(projectId, epicId, epicId) as Array<{
      id: number; path: string; content_hash: string | null;
      storage_kind: string | null; metadata: string;
      project_repository_id: number | null; local_path: string | null;
    }>;
    const result: Array<
      | { kind: 'file_backed'; artifactId: number; bindingId: number; relativePath: string; absolutePath: string; expectedHash: string | null }
      | { kind: 'db_native'; artifactId: number; canonicalContent: unknown; expectedHash: string | null }
    > = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const storageKind = readArtifactStorageKind(row.storage_kind);
      if (storageKind === null) {
        throw new Error(`CHECKPOINT_ARTIFACT_STORAGE_KIND_MISSING: artifact ${row.id}`);
      }
      if (storageKind === 'external_ref') {
        // Reserved for future use; no current producer emits external_ref.
        throw new Error(`CHECKPOINT_ARTIFACT_EXTERNAL_REF_UNSUPPORTED: artifact ${row.id}`);
      }
      if (storageKind === 'db_native') {
        // db-native artifact: no physical file is authority. The canonical
        // content lives in metadata.content; integrity is proven by
        // sha256(canonicalJson(content)) === content_hash. A projection file
        // MAY exist but is not captured or verified here.
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          throw new Error(`CHECKPOINT_ARTIFACT_DB_CONTENT_MISSING: artifact ${row.id} (metadata not JSON)`);
        }
        if (!parsed || typeof parsed.content !== 'object' || parsed.content === null) {
          throw new Error(`CHECKPOINT_ARTIFACT_DB_CONTENT_MISSING: artifact ${row.id}`);
        }
        result.push({
          kind: 'db_native',
          artifactId: row.id,
          canonicalContent: parsed.content,
          expectedHash: row.content_hash && /^[a-f0-9]{64}$/i.test(row.content_hash)
            ? row.content_hash.toLowerCase()
            : null,
        });
        continue;
      }
      // file_backed: repo binding + physical file are mandatory.
      if (row.project_repository_id === null || !row.local_path) {
        throw new Error(`CHECKPOINT_ARTIFACT_REPOSITORY_UNBOUND: artifact ${row.id}`);
      }
      const root = realpathSync(row.local_path);
      const relative = row.path.split('#', 1)[0]!.replaceAll('\\', '/');
      const absolute = containedPath(root, relative);
      if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
        throw new Error(`CHECKPOINT_ARTIFACT_FILE_INVALID: artifact ${row.id} '${relative}'`);
      }
      const key = `${row.project_repository_id}:${relative}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        kind: 'file_backed',
        artifactId: row.id,
        bindingId: row.project_repository_id,
        relativePath: relative,
        absolutePath: absolute,
        expectedHash: !row.path.includes('#')
          && row.content_hash && /^[a-f0-9]{64}$/i.test(row.content_hash)
          ? row.content_hash.toLowerCase()
          : null,
      });
    }
    return result;
  }

  private readLogFiles(db: Database.Database, projectId: number, epicId: number | null): Array<{
    executionId: string; path: string;
  }> {
    const rows = db.prepare(
      `SELECT execution_id, log_path FROM worker_executions
        WHERE project_id=? AND (? IS NULL OR epic_id=?) AND log_path IS NOT NULL`,
    ).all(projectId, epicId, epicId) as Array<{ execution_id: string; log_path: string }>;
    return rows.filter(row => existsSync(row.log_path) && statSync(row.log_path).isFile())
      .map(row => ({ executionId: row.execution_id, path: row.log_path }));
  }

  private readRepositoryStates(db: Database.Database, projectId: number): RepositoryState[] {
    const rows = db.prepare(
      `SELECT id, local_path FROM project_repositories WHERE project_id=? AND status='active'`,
    ).all(projectId) as Array<{ id: number; local_path: string | null }>;
    return rows.map((row): RepositoryState => {
      if (!row.local_path || !existsSync(row.local_path)) {
        return { bindingId: row.id, localName: `repository-${row.id}`, head: null, status: null };
      }
      const head = spawnSync('git', ['-C', row.local_path, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
      const status = spawnSync('git', ['-C', row.local_path, 'status', '--porcelain=v1'], { encoding: 'utf8', windowsHide: true });
      return {
        bindingId: row.id,
        localName: path.basename(row.local_path),
        head: head.status === 0 ? head.stdout.trim() : null,
        status: status.status === 0 ? status.stdout : null,
      };
    });
  }

  private readLifecycleCursor(db: Database.Database, projectId: number, epicId: number | null): {
    lifecycleRunId: number; inputHash: string; cursor: Record<string, unknown>;
  } | null {
    const row = db.prepare(
      `SELECT id, input_hash, status, current_stage_id, current_stage_run_id,
              definition_hash, idempotency_key
         FROM factory_lifecycle_runs
        WHERE project_id=? AND (? IS NULL OR epic_id=?)
        ORDER BY CASE WHEN status IN ('created','running','paused') THEN 0 ELSE 1 END, id DESC
        LIMIT 1`,
    ).get(projectId, epicId, epicId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      lifecycleRunId: Number(row.id),
      inputHash: String(row.input_hash),
      cursor: {
        status: row.status, currentStageId: row.current_stage_id,
        currentStageRunId: row.current_stage_run_id,
        definitionHash: row.definition_hash, idempotencyKey: row.idempotency_key,
      },
    };
  }

  private readReusableNodeResults(
    db: Database.Database,
    projectId: number,
    epicId: number | null,
  ): CapturedNodeResult[] {
    if (!this.tableExists(db, 'factory_node_runs') || !this.tableExists(db, 'factory_process_runs')) return [];
    const rows = db.prepare(
      `SELECT nr.id, nr.process_run_id, nr.node_id, nr.event, nr.output_ref,
              nr.output_schema, nr.output_hash, nr.output_bindings,
              nr.execution_receipt, pr.input_hash, pr.package_digest
         FROM factory_node_runs nr
         JOIN factory_process_runs pr ON pr.id=nr.process_run_id
        WHERE pr.project_id=? AND (? IS NULL OR pr.epic_id=?)
          AND nr.status='completed' AND nr.event IN ('runtime.completed','runtime.paused')
        ORDER BY nr.id`,
    ).all(projectId, epicId, epicId) as Array<Record<string, unknown>>;
    return rows.map((row): CapturedNodeResult | null => {
      const production = row.output_ref && row.output_schema && row.output_hash
        ? {
            schema: String(row.output_schema), artifactRef: String(row.output_ref),
            contentHash: String(row.output_hash),
            bindings: parseRecord(row.output_bindings),
          }
        : undefined;
      let receipt = row.execution_receipt
        ? JSON.parse(String(row.execution_receipt)) as NodeExecutionResult['receipt']
        : undefined;
      if (row.event === 'runtime.paused') {
        // A review pause becomes reusable only after the exact task reached
        // done and durable managed production identifies the author execution.
        // A mere file or an in-review task is never promoted by capture.
        if (!receipt || !Number.isSafeInteger(receipt.taskId)) return null;
        const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(receipt.taskId) as
          | { status: string }
          | undefined;
        if (task?.status !== 'done') return null;
        let producerExecutionId: string | null = null;
        if (this.tableExists(db, 'factory_managed_artifact_productions')) {
          const producer = db.prepare(
            `SELECT execution_id FROM factory_managed_artifact_productions
              WHERE process_run_id=? AND node_id=? AND task_id=?
              ORDER BY id DESC LIMIT 1`,
          ).get(row.process_run_id, row.node_id, receipt.taskId) as
            | { execution_id: string }
            | undefined;
          producerExecutionId = producer?.execution_id ?? null;
        }
        if (!producerExecutionId && this.tableExists(db, 'factory_managed_node_submissions')) {
          const producer = db.prepare(
            `SELECT execution_id FROM factory_managed_node_submissions
              WHERE process_run_id=? AND node_id=? AND task_id=?
              ORDER BY id DESC LIMIT 1`,
          ).get(row.process_run_id, row.node_id, receipt.taskId) as
            | { execution_id: string }
            | undefined;
          producerExecutionId = producer?.execution_id ?? null;
        }
        if (!producerExecutionId) return null;
        receipt = {
          ...receipt,
          executionId: producerExecutionId,
          runtimeStatus: 'completed',
          replayed: true,
        };
      }
      return {
        nodeRunId: Number(row.id), processRunId: Number(row.process_run_id),
        nodeId: String(row.node_id), packageDigest: row.package_digest ? String(row.package_digest) : null,
        processInputHash: String(row.input_hash),
        result: { runtimeEvent: 'completed', ...(production ? { production } : {}), ...(receipt ? { receipt } : {}) },
      };
    }).filter((item): item is CapturedNodeResult => Boolean(
      item && (item.result.production || item.result.receipt),
    ));
  }

  private readWarmStartNodes(
    db: Database.Database,
    projectId: number,
    epicId: number | null,
    objects: readonly CheckpointObject[],
  ): WarmStartNode[] {
    if (!this.tableExists(db, 'factory_managed_artifact_productions')) return [];
    const rows = db.prepare(
      `SELECT mp.module_ref, mp.node_id, mp.artifact_id, a.path,
              a.project_repository_id
         FROM factory_managed_artifact_productions mp
         JOIN factory_process_runs pr ON pr.id=mp.process_run_id
         JOIN artifacts a ON a.id=mp.artifact_id
        WHERE pr.project_id=? AND (? IS NULL OR pr.epic_id=?)
        ORDER BY mp.id`,
    ).all(projectId, epicId, epicId) as Array<{
      module_ref: string; node_id: string; artifact_id: number;
      path: string; project_repository_id: number | null;
    }>;
    const groups = new Map<string, {
      moduleRef: string; nodeId: string;
      drafts: Map<string, WarmStartNode['drafts'][number]>;
    }>();
    for (const row of rows) {
      const relative = row.path.split('#', 1)[0]!.replaceAll('\\', '/');
      const object = objects.find(candidate =>
        candidate.kind === 'artifact'
        && candidate.bindingId === row.project_repository_id
        && candidate.relativePath === relative,
      );
      if (!object) continue;
      const key = `${row.module_ref}\0${row.node_id}`;
      const group = groups.get(key) ?? {
        moduleRef: row.module_ref,
        nodeId: row.node_id,
        drafts: new Map<string, WarmStartNode['drafts'][number]>(),
      };
      group.drafts.set(relative, {
        slot: path.posix.basename(relative),
        path: relative,
        policy: 'locked',
        sha256: object.digest,
      });
      groups.set(key, group);
    }
    return [...groups.values()].map(group => ({
      moduleRef: group.moduleRef,
      nodeId: group.nodeId,
      drafts: [...group.drafts.values()],
    }));
  }

  private putObject(
    storageRoot: string,
    source: string,
    metadata: Omit<CheckpointObject, 'digest' | 'size' | 'objectPath'>,
  ): CheckpointObject {
    const bytes = readFileSync(source);
    const digest = sha256(bytes);
    const relative = path.join('objects', 'sha256', digest.slice(0, 2), digest);
    const destination = containedPath(storageRoot, relative);
    if (!existsSync(destination)) {
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const temp = `${destination}.${randomUUID()}.tmp`;
      writeFileSync(temp, bytes, { mode: 0o600 });
      renameSync(temp, destination);
      try { chmodSync(destination, 0o600); } catch { /* Windows ACLs are host-owned. */ }
    }
    return { ...metadata, digest, size: bytes.length, objectPath: relative.replaceAll('\\', '/') };
  }

  private verifyObject(storageRoot: string, object: CheckpointObject): void {
    const absolute = this.objectAbsolutePath(storageRoot, object);
    if (!existsSync(absolute) || statSync(absolute).size !== object.size) {
      throw new Error(`CHECKPOINT_OBJECT_MISSING_OR_TRUNCATED: ${object.sourceRef}`);
    }
    if (sha256(readFileSync(absolute)) !== object.digest) {
      throw new Error(`CHECKPOINT_OBJECT_DIGEST_MISMATCH: ${object.sourceRef}`);
    }
  }

  private objectAbsolutePath(storageRoot: string, object: CheckpointObject): string {
    return containedPath(storageRoot, object.objectPath);
  }

  private verifyDatabase(dbPath: string): void {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`CHECKPOINT_DATABASE_INTEGRITY_FAILED: ${canonicalJson(integrity)}`);
      }
      const foreignKeys = db.pragma('foreign_key_check') as unknown[];
      if (foreignKeys.length > 0) throw new Error('CHECKPOINT_DATABASE_FOREIGN_KEY_FAILED');
    } finally { db.close(); }
  }

  private assertScope(db: Database.Database, projectId: number, epicId: number | null): void {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) {
      throw new Error(`CHECKPOINT_PROJECT_NOT_FOUND: ${projectId}`);
    }
    if (epicId !== null && !db.prepare('SELECT 1 FROM epics WHERE id=? AND project_id=?').get(epicId, projectId)) {
      throw new Error(`CHECKPOINT_EPIC_SCOPE_MISMATCH: ${epicId}`);
    }
  }

  private ensureDatabaseIdentity(db: Database.Database): string {
    const existing = db.prepare(
      'SELECT namespace_id FROM factory_database_identity WHERE singleton_id=1',
    ).get() as { namespace_id: string } | undefined;
    if (existing) return existing.namespace_id;
    const namespace = randomUUID();
    db.prepare(
      'INSERT INTO factory_database_identity (singleton_id, namespace_id) VALUES (1, ?)',
    ).run(namespace);
    return namespace;
  }

  private nextSequence(db: Database.Database, projectId: number, epicId: number | null): number {
    const row = db.prepare(
      `SELECT COALESCE(MAX(sequence_no),0)+1 AS n FROM factory_checkpoints
        WHERE project_id=? AND epic_id IS ?`,
    ).get(projectId, epicId) as { n: number };
    return row.n;
  }

  private latestCheckpointRef(db: Database.Database, projectId: number, epicId: number | null): string | null {
    const row = db.prepare(
      `SELECT checkpoint_ref FROM factory_checkpoints
        WHERE project_id=? AND epic_id IS ? AND status='complete'
        ORDER BY sequence_no DESC LIMIT 1`,
    ).get(projectId, epicId) as { checkpoint_ref: string } | undefined;
    return row?.checkpoint_ref ?? null;
  }

  private tableExists(db: Database.Database, name: string): boolean {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  private atomicWrite(destination: string, body: string): void {
    const temp = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, destination);
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(String(value)) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function containedPath(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`CHECKPOINT_PATH_ABSOLUTE: ${relative}`);
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`CHECKPOINT_PATH_ESCAPE: ${relative}`);
  }
  return target;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
