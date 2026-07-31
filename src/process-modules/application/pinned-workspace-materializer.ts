/**
 * Pinned-package workspace materializer (SPI cutover Seam C).
 *
 * Replaces the legacy `safeAssetPath(workspaceRoot, asset)` resource lookup in
 * `prepareProcessExecutionWorkspace` with a pinned-package source: reads bytes
 * from a verified `ModulePackageStore.read(packageDigest)` result instead of
 * reconstructing filesystem paths or reading the project tree. This closes
 * W13-AUDIT bug #4 (`PROCESS_WORKSPACE_ASSET_MISSING` when workspaceRoot ≠ the
 * saga-mcp repo root) and W13-AUDIT §18.9 (resources ship with the owning
 * package, resolved from pinned bytes).
 *
 * The materializer preserves the legacy execution-directory physics + retry
 * idempotency byte-for-byte: it reuses the exported helpers from
 * `process-execution-workspace.ts` (buildMachineBindings, fillKnownPlaceholders,
 * refreshMarkdown/JsonMachineBindings, materializedName, relativeWorkspacePath,
 * recoveryFeedbackFromMetadata) so the 15-key markdown allowlist and 13-key
 * JSON allowlist that define "what gets refreshed on retry" stay single-source.
 *
 * Source resolution difference vs legacy:
 *   legacy:  safeAssetPath(workspaceRoot, asset)  → reads from project tree
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
import type { ProcessExecutionWorkspace, ProcessExecutionWorkspaceTask } from './process-execution-workspace.js';
import {
  buildMachineBindings,
  fillKnownPlaceholders,
  refreshJsonMachineBindings,
  refreshMarkdownMachineBindings,
  materializedName,
  relativeWorkspacePath,
  recoveryFeedbackFromMetadata,
  parseMetadata,
} from './process-execution-workspace.js';
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
 * Input to the pinned-package materializer. Mirrors the legacy request shape,
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
  if (candidates.length !== 1) {
    throw new Error(
      `AGENT_ASSISTANCE_NODE_AMBIGUOUS: profile '${profile.id}' maps to `
      + `${candidates.length} LM nodes`,
    );
  }
  return candidates[0].id;
}

/**
 * Materialize the pinned-package workspace into the project tree.
 *
 * Produces the same directory layout, tracker filename, and metadata shape as
 * `prepareProcessExecutionWorkspace` so downstream consumers
 * (`legacy-claude-worker-executor-factory.ts`, `tasks.ts:734`,
 * `claude-runner.mjs`) need NO changes. The only difference is the SOURCE of
 * the template/checklist/tracker bytes: pinned storeLocation instead of the
 * workspace tree.
 */
export function materializePinnedWorkspace(
  request: MaterializePinnedWorkspaceRequest,
): ProcessExecutionWorkspace {
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

  // 3. Asset lists from the profile (same fields the legacy path reads).
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
  //    retry-idempotency (reuse the legacy helpers verbatim).
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

  // 6. Tracker — materialize into projectDirectory with the exact legacy
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
  let agentAssistanceAbsolutePath: string | undefined;
  if (assistanceDefinitions.length > 0) {
    const nodeId = resolveOwningNodeId(module, profile, metadata);
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

  // 8. Return exact execution-scoped paths to consumers.
  return {
    profileId: profile.id,
    moduleRef: `${module.identity.name}@${module.identity.version}`,
    trackerPath: relativeWorkspacePath(workspaceRoot, trackerAbsolutePath),
    trackerAbsolutePath,
    ...(agentAssistanceAbsolutePath ? { agentAssistanceAbsolutePath } : {}),
    executionDirectory: relativeWorkspacePath(workspaceRoot, executionDirectory),
    workspaceFiles: [
      ...workspaceTemplates.map(a => materializedBySource.get(a)).filter((v): v is string => !!v),
      ...(recoveryFeedbackPath ? [relativeWorkspacePath(workspaceRoot, recoveryFeedbackPath)] : []),
    ],
    callFiles: callTemplates
      .map(a => materializedBySource.get(a))
      .filter((v): v is string => !!v),
    checklists: checklists.map(asset =>
      relativeWorkspacePath(workspaceRoot, path.join(toolsDirectory, path.basename(asset))),
    ),
  };
}
