/**
 * Pinned-package workspace materializer (SPI cutover Seam C).
 *
 * `prepareProcessExecutionWorkspace` with a pinned-package source: reads bytes
 * from a verified `ModulePackageStore.read(packageDigest)` result instead of
 * reconstructing filesystem paths or reading the project tree. This closes
 * W13-AUDIT bug #4 (`PROCESS_WORKSPACE_ASSET_MISSING` when workspaceRoot ≠ the
 * saga-mcp repo root) and W13-AUDIT §18.9 (resources ship with the owning
 * package, resolved from pinned bytes).
 *
 * idempotency byte-for-byte: it reuses the exported helpers from
 * `process-execution-workspace.ts` (buildMachineBindings, fillKnownPlaceholders,
 * refreshMarkdown/JsonMachineBindings, materializedName, relativeWorkspacePath,
 * recoveryFeedbackFromMetadata) so the 15-key markdown allowlist and 13-key
 * JSON allowlist that define "what gets refreshed on retry" stay single-source.
 *
 *   pinned:  resolveResource(projection, storedPackage, assetPath) reads the
 *            exact logicalId blob already verified by the package-store port.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { WorkspaceProjection } from './workspace-projection.js';
import type { ProcessExecutionWorkspaceTask } from './process-execution-workspace.js';
import type { RepositoryDesk } from './repository-desk.js';
import {
  buildMachineBindings,
  fillKnownPlaceholders,
  refreshJsonMachineBindings,
  refreshMarkdownMachineBindings,
  materializedName,
  relativeWorkspacePath,
  recoveryFeedbackFromMetadata,
  reviewFeedbackFromMetadata,
  parseMetadata,
} from './process-execution-workspace.js';

/**
 * saga4 LEGO contract — Layer 1 (Workplace Desk).
 *
 * Replaces the loose {@link ProcessExecutionWorkspace} struct that pinned and
 * materializer is the SOLE desk creator, so the contract is owned here and the
 *
 * INVARIANTS (enforced by {@link assertDeskInvariants} before every return):
 *   I1. trackerAbsolutePath endsWith `node-${nodeId}.md` (node-stable tracker).
 *   I2. executionDirectory includes `node-${nodeId}` (desk keyed by node, P18).
 *   I3. agentAssistance.required === true  → path !== null.
 *   I4. recoveryFeedback.present === true   → path !== null.
 *   I5. reviewFeedback.present === true     → path !== null.
 *
 * Backward-compatibility slots ({@link workspaceFiles},
 * {@link agentAssistanceAbsolutePath}, {@link testWarmStart}) are kept so the
 * `tracker-view/claude-runner.mjs`, `test-warm-start.ts`) need no edits. They
 * will be removed once those consumers migrate to the strict fields.
 */
export interface WorkplaceDesk {
  // IDENTITY (REQUIRED)
  readonly nodeId: string;
  readonly profileId: string;
  readonly moduleRef: string;

  // PATHS (REQUIRED)
  readonly trackerPath: string;
  readonly trackerAbsolutePath: string;
  readonly executionDirectory: string;

  // CONTENT (REQUIRED arrays)
  readonly callFiles: readonly string[];
  readonly checklists: readonly string[];

  // FEEDBACK (explicit presence)
  readonly recoveryFeedback: { readonly present: boolean; readonly path: string | null };
  readonly reviewFeedback: { readonly present: boolean; readonly path: string | null };

  // HOOKS (invariant I3)
  readonly agentAssistance: { readonly required: boolean; readonly path: string | null };

  // -- Backward-compatibility slots (consumers migrate later) --
  /**
   * Computed = {@link callFiles} + non-null feedback paths. Kept for the
   * claude-runner prompt that inlines `workspace_files=...` and for
   * `test-warm-start.ts` which looks up slots by basename against this set.
   */
  readonly workspaceFiles: readonly string[];
  /** Absolute path to agent-assistance.json, or undefined when not required. */
  readonly agentAssistanceAbsolutePath?: string;
  /**
   * Optional test-only warm-start projection produced by an outer infrastructure
   * adapter. Process modules never read or create it.
   */
  readonly testWarmStart?: {
    readonly fixtureId: string;
    readonly mode: 'verify-and-submit-existing-draft';
    readonly nodeId: string;
    readonly draftFiles: readonly string[];
    readonly coldStartFiles: readonly string[];
    readonly forceRewriteSlots: readonly string[];
    readonly instruction: string;
    readonly receiptPath: string;
    readonly cacheRoot: string;
    readonly cacheEntries: readonly {
      readonly slot: string;
      readonly policy: 'learn' | 'locked';
      readonly targetPath: string;
      readonly cachePath: string | null;
      readonly metadataPath: string | null;
      readonly packageDigest: string | null;
      readonly inputHash: string | null;
    }[];
  };

  /**
   * Machine-provisioned git execution environment for code-changing workers.
   * Present only for git_change tasks. The factory (not the LM) creates the
   * worktree, selects the branch, and freezes the base commit. The runner
   * spawns the worker with `cwd = repositoryDesk.executionPath`.
   */
  readonly repositoryDesk?: RepositoryDesk;
}

/**
 * Verify the WorkplaceDesk contract before returning it to a worker. Each
 * invariant maps to a CGAD P18 (node-durable identity) or feedback-promise
 * guarantee. Throws with a code prefix so the failing assertion is obvious in
 * logs. Run this immediately before `return` in every desk creator.
 */
export function assertDeskInvariants(desk: WorkplaceDesk): void {
  // I1: trackerAbsolutePath endsWith `node-${nodeId}.md`
  const expectedTrackerSuffix = `node-${desk.nodeId}.md`;
  if (!desk.trackerAbsolutePath.endsWith(expectedTrackerSuffix)) {
    throw new Error(
      `WORKPLACE_DESK_TRACKER_NOT_NODE_STABLE: trackerAbsolutePath `
      + `'${desk.trackerAbsolutePath}' must end with '${expectedTrackerSuffix}' `
      + `(nodeId='${desk.nodeId}'). CGAD P18 requires one tracker per workplace.`,
    );
  }
  // I2: executionDirectory includes `node-${nodeId}`
  const expectedDirSegment = `node-${desk.nodeId}`;
  if (!desk.executionDirectory.includes(expectedDirSegment)) {
    throw new Error(
      `WORKPLACE_DESK_DIR_NOT_NODE_KEYED: executionDirectory `
      + `'${desk.executionDirectory}' must include '${expectedDirSegment}' `
      + `(nodeId='${desk.nodeId}'). The desk directory is keyed by node, not task.`,
    );
  }
  // I3: agentAssistance.required === true → path !== null
  if (desk.agentAssistance.required && desk.agentAssistance.path === null) {
    throw new Error(
      `WORKPLACE_DESK_ASSISTANCE_REQUIRED_BUT_MISSING: pinned module declares `
      + `assistance for node '${desk.nodeId}' but no agent-assistance.json path `
      + `was materialized on the desk.`,
    );
  }
  // I4: recoveryFeedback.present === true → path !== null
  if (desk.recoveryFeedback.present && desk.recoveryFeedback.path === null) {
    throw new Error(
      `WORKPLACE_DESK_RECOVERY_PRESENT_BUT_NO_PATH: recoveryFeedback.present `
      + `is true for node '${desk.nodeId}' but path is null.`,
    );
  }
  // I5: reviewFeedback.present === true → path !== null
  if (desk.reviewFeedback.present && desk.reviewFeedback.path === null) {
    throw new Error(
      `WORKPLACE_DESK_REVIEW_PRESENT_BUT_NO_PATH: reviewFeedback.present `
      + `is true for node '${desk.nodeId}' but path is null.`,
    );
  }
}
import type { ProcessModuleDefinition, ExecutionProfileDefinition } from '../domain/process-module.js';
import type {
  ResourceBlob,
  StoredModulePackage,
} from '../installation/index.js';
import {
  renderAgentAssistanceProjection,
  serializeAgentAssistanceProjection,
} from './agent-assistance-projection.js';
import type {
  ProcessWorkspaceTemplatePreparer,
} from './process-workspace-preparation.js';

/**
 * but the resource source is the pre-resolved WorkspaceProjection (bytes live
 * under projection.storeLocation) rather than workspaceRoot-relative assets.
 */
export interface MaterializePinnedWorkspaceRequest {
  /** The pinned-package projection (skills/templates/checklists/tracker). */
  readonly projection: WorkspaceProjection;
  /** Verified bytes returned by ModulePackageStore.read(packageDigest). */
  readonly storedPackage: StoredModulePackage;
  /** Project workspace root — targets are materialized under here (docs/...). */
  readonly workspaceRoot: string;
  /** The module definition (for identity.kind = stage directory name). */
  readonly module: ProcessModuleDefinition;
  /** The execution profile (for trackerTemplate pointer + output schema). */
  readonly profile: ExecutionProfileDefinition;
  readonly projectId: number;
  readonly epicId: number;
  readonly task: ProcessExecutionWorkspaceTask;
  readonly executionId: string | null;
  readonly workerId: string;
  readonly additionalBindings?: Readonly<Record<string, unknown>>;
  readonly templatePreparer?: ProcessWorkspaceTemplatePreparer;
}

/**
 * Resolve a module-relative resource path (as declared in the profile, e.g.
 * `src/.../package/resources/proposal-stage-tracker.md` OR a package-relative
 * `proposal-stage-tracker.md`) to its verified package blob via the
 * projection's allResources. Matches by exact relativePath, then by basename.
 *
 * The profile's trackerTemplate/workspaceTemplates/callTemplates/checklists
 * historically carried repo-root-relative POSIX paths (post-migration). The
 * projection's resourceIndex entries carry the same paths verbatim (the
 * installer does not rewrite them), so an exact match is the common case.
 * Basename fallback covers package-relative profile pointers.
 */
function resolveResource(
  projection: WorkspaceProjection,
  storedPackage: StoredModulePackage,
  declaredPath: string,
): ResourceBlob {
  if (storedPackage.packageDigest !== projection.packageDigest) {
    throw new Error(
      `PINNED_PACKAGE_DIGEST_MISMATCH: projection expects ${projection.packageDigest} `
      + `but store returned ${storedPackage.packageDigest}`,
    );
  }
  // Exact relativePath match.
  const exact = projection.allResources.find(r => r.relativePath === declaredPath);
  // Basename fallback.
  const base = path.posix.basename(declaredPath);
  const resolved = exact
    ?? projection.allResources.find(r => path.posix.basename(r.relativePath) === base);
  if (resolved) {
    const blob = storedPackage.resources.find(resource => resource.logicalId === resolved.logicalId);
    if (!blob) {
      throw new Error(
        `PINNED_RESOURCE_BYTES_MISSING: package ${projection.packageDigest} has no bytes `
        + `for logicalId '${resolved.logicalId}'`,
      );
    }
    if (blob.digest !== resolved.digest) {
      throw new Error(
        `PINNED_RESOURCE_DIGEST_MISMATCH: logicalId '${resolved.logicalId}' expected `
        + `${resolved.digest} but store returned ${blob.digest}`,
      );
    }
    return blob;
  }
  throw new Error(
    `PINNED_RESOURCE_NOT_IN_PACKAGE: profile references '${declaredPath}' but the pinned `
    + `installation ${projection.installationId} (${projection.moduleRef}) has no resource `
    + `with that path or basename. Declared resources: `
    + projection.allResources.map(r => r.relativePath).join(', '),
  );
}

function readPinnedText(
  projection: WorkspaceProjection,
  storedPackage: StoredModulePackage,
  declaredPath: string,
): string {
  return new TextDecoder().decode(resolveResource(projection, storedPackage, declaredPath).bytes);
}

function executionPathSegment(executionId: string | null, workerId: string): string {
  const raw = executionId ?? `worker-${workerId}`;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error('PINNED_WORKSPACE_EXECUTION_ID_INVALID');
  }
  return safe;
}

function integerBinding(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function resolveOwningNodeId(
  module: ProcessModuleDefinition,
  profile: ExecutionProfileDefinition,
  metadata: Record<string, unknown>,
): string {
  const declared = metadata.process_node_id;
  if (typeof declared === 'string' && declared.length > 0) return declared;

  const candidates = module.flow.nodes.filter(node =>
    node.kind === 'lm' && node.executionProfile === profile.id,
  );
  if (candidates.length === 1) return candidates[0].id;

  // CGAD P18 — Node-Durable Identity for flow-less profiles: some execution
  // profiles (e.g. development-implementation-worker) are claimed through the
  // shared worker_next queue and have NO matching Flow LM node. Their "workplace"
  // is a stable virtual node keyed by the profile id, so a worker returning to
  // the same profile reuses the same desk + card. The virtual id is namespaced
  // by the module kind to avoid collisions across modules.
  if (candidates.length === 0) {
    return `profile:${module.identity.kind}:${profile.id}`;
  }

  throw new Error(
    `AGENT_ASSISTANCE_NODE_AMBIGUOUS: profile '${profile.id}' maps to `
    + `${candidates.length} LM nodes`,
  );
}

/**
 * Materialize the pinned-package workspace into the project tree.
 *
 * Produces the same directory layout, tracker filename, and metadata shape as
 * `claude-runner.mjs`) need NO changes. The only difference is the SOURCE of
 * the template/checklist/tracker bytes: pinned storeLocation instead of the
 * workspace tree.
 *
 * saga4 cutover: returns the strict {@link WorkplaceDesk} contract. The
 * invariants are enforced by {@link assertDeskInvariants} before this function
 * returns, so no caller can ever observe a desk that violates I1–I5.
 */
export function materializePinnedWorkspace(
  request: MaterializePinnedWorkspaceRequest,
): WorkplaceDesk {
  const { projection, storedPackage, module, profile, task } = request;
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const stage = module.identity.kind;
  const metadata = parseMetadata(task.metadata);
  // CGAD P18 — Node-Durable Identity: the workplace (node) is the primary
  // durable entity. The execution directory is keyed by the NODE, not the task,
  // so a repair worker reuses the SAME desk as the producer and its prior
  // drafts survive. The per-execution segment (executionId/workerId) still
  // isolates individual worker runs underneath the node desk.
  const nodeId = resolveOwningNodeId(module, profile, metadata);

  // 1. Target directory physics — node-stable desk (CGAD P18).
  const stageRoot = path.join(workspaceRoot, 'docs', stage);
  const projectDirectory = path.join(stageRoot, 'projects', String(request.epicId));
  const executionDirectory = path.join(
    projectDirectory,
    'executions',
    `node-${nodeId}`,
    executionPathSegment(request.executionId, request.workerId),
  );
  const toolsDirectory = path.join(executionDirectory, 'tools');
  mkdirSync(toolsDirectory, { recursive: true });
  mkdirSync(executionDirectory, { recursive: true });

  const bindings = buildMachineBindings({
    workspaceRoot,
    module,
    profile,
    projectId: request.projectId,
    epicId: request.epicId,
    task,
    executionId: request.executionId,
    workerId: request.workerId,
    additionalBindings: request.additionalBindings,
  });
  // (metadata parsed above for nodeId resolution — CGAD P18)

  // 2. recovery-feedback.json — always overwritten (machine-owned loop input).
  let recoveryFeedbackPath: string | null = null;
  const recoveryFeedback = recoveryFeedbackFromMetadata(metadata);
  if (recoveryFeedback) {
    recoveryFeedbackPath = path.join(executionDirectory, 'recovery-feedback.json');
    writeFileSync(recoveryFeedbackPath, `${JSON.stringify(recoveryFeedback, null, 2)}\n`);
  }
  // CGAD P18 — review-loop is a rework cycle, same model as recovery: a worker
  // arrives at the workplace and must see the reviewer's feedback about what to
  // fix. The dispatcher records the reviewer's `result` in
  // managed_review_last_feedback on changes_requested; this surfaces it on the
  // desk so the author never reworks blind. Mirrors recovery-feedback.json.
  let reviewFeedbackPath: string | null = null;
  const reviewFeedback = reviewFeedbackFromMetadata(metadata);
  if (reviewFeedback) {
    reviewFeedbackPath = path.join(executionDirectory, 'review-feedback.json');
    writeFileSync(reviewFeedbackPath, `${JSON.stringify(reviewFeedback, null, 2)}\n`);
  }

  const workspaceTemplates = profile.workspaceTemplates ?? [];
  const callTemplates = profile.callTemplates ?? [];
  const checklists = profile.checklists ?? [];

  // CGAD P18 — draft inheritance is now NODE-scoped: the desk directory
  // (`executions/node-<nodeId>/`) holds every worker run of this workplace, so
  // a repair worker naturally inherits the producer's prior drafts. The guard
  // excludes only the current execution; siblings are all same-node runs.
  const taskDirectory = path.dirname(executionDirectory);
  const expectedMaterializedFiles = [...new Set([
    ...workspaceTemplates,
    ...callTemplates,
  ])].map(materializedName);
  let previousExecutionDirectories: string[] = [];
  try {
    previousExecutionDirectories = readdirSync(taskDirectory)
      .map(name => path.join(taskDirectory, name))
      .filter(candidate =>
        candidate !== executionDirectory
        && existsSync(candidate)
        && statSync(candidate).isDirectory())
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  } catch {
    previousExecutionDirectories = [];
  }
  for (const fileName of expectedMaterializedFiles) {
    const target = path.join(executionDirectory, fileName);
    if (existsSync(target)) continue;
    const source = previousExecutionDirectories
      .map(directory => path.join(directory, fileName))
      .find(candidate => existsSync(candidate));
    if (source) writeFileSync(target, readFileSync(source));
  }

  // 4. Stage shared copies into tools/ — first-writer-wins (idempotent).
  const allAssets = [...new Set([
    ...(profile.trackerTemplate ? [profile.trackerTemplate] : []),
    ...workspaceTemplates,
    ...callTemplates,
    ...checklists,
  ])];
  for (const asset of allAssets) {
    const sharedTarget = path.join(toolsDirectory, path.basename(asset));
    if (!existsSync(sharedTarget)) {
      writeFileSync(sharedTarget, readPinnedText(projection, storedPackage, asset));
    }
  }

  // 5. Materialize workspace + call templates into executionDirectory/ with
  const materializedBySource = new Map<string, string>();
  for (const asset of [...new Set([...workspaceTemplates, ...callTemplates])]) {
    const target = path.join(executionDirectory, materializedName(asset));
    const sourceContent = readPinnedText(projection, storedPackage, asset);
    const isFresh = !existsSync(target);
    if (isFresh) {
      const prepared = path.extname(target).toLowerCase() === '.json'
        ? refreshJsonMachineBindings(sourceContent, bindings)
        : fillKnownPlaceholders(sourceContent, bindings);
      writeFileSync(target, prepared);
    } else if (path.extname(target).toLowerCase() === '.json') {
      // Retry: preserve semantic work, refresh only execution-scoped fields.
      const existing = readFileSync(target, 'utf8');
      writeFileSync(target, refreshJsonMachineBindings(existing, bindings));
    }
    if (request.templatePreparer) {
      const currentContent = readFileSync(target, 'utf8');
      const prepared = request.templatePreparer({
        module,
        profile,
        task,
        projectId: request.projectId,
        epicId: request.epicId,
        nodeId: typeof bindings.NODE_ID === 'string' ? bindings.NODE_ID : null,
        declaredPath: asset,
        materializedName: path.basename(target),
        sourceContent,
        currentContent,
        isFresh,
      });
      if (prepared !== null && prepared !== currentContent) {
        writeFileSync(target, prepared);
      }
    }
    materializedBySource.set(asset, relativeWorkspacePath(workspaceRoot, target));
  }

  //    filename pattern (consumers depend on it). Retry reads existing file
  //    so worker checkpoint edits survive.
  if (!profile.trackerTemplate) {
    throw new Error(`PROCESS_WORKSPACE_TRACKER_MISSING: profile '${profile.id}' has no tracker template`);
  }
  const trackerSourceContent = readPinnedText(
    projection,
    storedPackage,
    profile.trackerTemplate,
  );
  // CGAD P18: tracker filename is node-stable (one tracker per workplace),
  // so a repair worker continues the producer's tracker rather than starting
  // a fresh file each round.
  const trackerAbsolutePath = path.join(
    executionDirectory,
    `project-${request.epicId}-${stage}-node-${nodeId}.md`,
  );
  if (!existsSync(trackerAbsolutePath)) {
    const tracker = refreshMarkdownMachineBindings(
      trackerSourceContent,
      bindings,
    );
    writeFileSync(trackerAbsolutePath, tracker);
  } else {
    const tracker = refreshMarkdownMachineBindings(
      readFileSync(trackerAbsolutePath, 'utf8'),
      bindings,
    );
    writeFileSync(trackerAbsolutePath, tracker);
  }

  // 7. Package-owned structured assistance. The runtime hydrates only
  // machine-known paths/authority and writes it beside the execution tracker;
  // the generic Claude hook never switches on a module or node name.
  const assistanceDefinitions = storedPackage.manifest.assistance ?? [];
  // saga4 WorkplaceDesk I3: `required` is true iff the package declares ANY
  // assistance definition (the package's authority surface). When required,
  // a definition for THIS node must exist and a path must be materialized;
  // assertDeskInvariants enforces the path promise (non-null iff required).
  const agentAssistanceRequired = assistanceDefinitions.length > 0;
  let agentAssistanceAbsolutePath: string | undefined;
  if (agentAssistanceRequired) {
    const assistanceDefinition = assistanceDefinitions.find(
      definition => definition.nodeId === nodeId,
    );
    if (!assistanceDefinition) {
      throw new Error(
        `AGENT_ASSISTANCE_DEFINITION_MISSING: pinned module `
        + `${module.identity.name}@${module.identity.version} declares assistance `
        + `but has no definition for LM node '${nodeId}'`,
      );
    }
    const processRunId = integerBinding(metadata.process_run_id);
    const attempt = integerBinding(metadata.process_node_attempt)
      ?? integerBinding(metadata.attempt)
      ?? 1;
    agentAssistanceAbsolutePath = path.join(
      executionDirectory,
      'agent-assistance.json',
    );
    const assistanceProjection = renderAgentAssistanceProjection({
      definition: assistanceDefinition,
      executionId: request.executionId,
      processRunId,
      nodeId,
      attempt,
      bindings: {
        NODE_ID: nodeId,
        TRACKER_PATH: relativeWorkspacePath(workspaceRoot, trackerAbsolutePath),
        CALL_FILES: callTemplates
          .map(asset => materializedBySource.get(asset))
          .filter((value): value is string => !!value)
          .join(', ') || '(none)',
        CHECKLISTS: checklists
          .map(asset => relativeWorkspacePath(
            workspaceRoot,
            path.join(toolsDirectory, path.basename(asset)),
          ))
          .join(', ') || '(none)',
        ALLOWED_TOOLS: profile.allowedTools.join(', '),
      },
    });
    writeFileSync(
      agentAssistanceAbsolutePath,
      serializeAgentAssistanceProjection(assistanceProjection),
    );
  }

  // 8. Build the strict WorkplaceDesk (saga4 LEGO contract, Layer 1).
  //    `workspaceFiles` is the computed backward-compatible flat list:
  //    workspace call files + recovery/review feedback paths (when present).
  const materializedCallFiles = callTemplates
    .map(a => materializedBySource.get(a))
    .filter((v): v is string => !!v);
  const recoveryFeedbackRelative = recoveryFeedbackPath
    ? relativeWorkspacePath(workspaceRoot, recoveryFeedbackPath)
    : null;
  const reviewFeedbackRelative = reviewFeedbackPath
    ? relativeWorkspacePath(workspaceRoot, reviewFeedbackPath)
    : null;
  const desk: WorkplaceDesk = {
    nodeId,
    profileId: profile.id,
    moduleRef: `${module.identity.name}@${module.identity.version}`,
    trackerPath: relativeWorkspacePath(workspaceRoot, trackerAbsolutePath),
    trackerAbsolutePath,
    executionDirectory: relativeWorkspacePath(workspaceRoot, executionDirectory),
    callFiles: materializedCallFiles,
    checklists: checklists.map(asset =>
      relativeWorkspacePath(workspaceRoot, path.join(toolsDirectory, path.basename(asset))),
    ),
    recoveryFeedback: {
      present: recoveryFeedbackPath !== null,
      path: recoveryFeedbackRelative,
    },
    reviewFeedback: {
      present: reviewFeedbackPath !== null,
      path: reviewFeedbackRelative,
    },
    agentAssistance: {
      required: agentAssistanceRequired,
      path: agentAssistanceAbsolutePath
        ? relativeWorkspacePath(workspaceRoot, agentAssistanceAbsolutePath)
        : null,
    },
    // list shape exactly (workspace templates + feedback paths).
    workspaceFiles: [
      ...workspaceTemplates.map(a => materializedBySource.get(a)).filter((v): v is string => !!v),
      ...(recoveryFeedbackRelative ? [recoveryFeedbackRelative] : []),
      ...(reviewFeedbackRelative ? [reviewFeedbackRelative] : []),
    ],
    ...(agentAssistanceAbsolutePath ? { agentAssistanceAbsolutePath } : {}),
  };
  // saga4: enforce I1–I5 before the desk reaches any consumer. A failing
  // invariant here is a contract bug in the materializer, not a runtime fault.
  assertDeskInvariants(desk);
  return desk;
}
