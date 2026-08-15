/**
 * Pinned-package workspace materializer.
 *
 * The logical Workplace is durable across worker/reviewer/repair executions.
 * For Production Cell work its physical desk MUST therefore be scoped by the
 * exact `workplace_ref`, not merely by the Flow node. A node may fan out into
 * several Workplaces with distinct workKeys; sharing one node-level sibling
 * directory lets one work item inherit another item's drafts by filesystem
 * recency. The materializer keeps execution-specific scratch below an exact
 * Workplace root and keeps the tracker at that stable root.
 */

import { createHash } from 'node:crypto';
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
 * `workplaceRef` is nullable only for legacy/non-Production-Cell tasks that do
 * not carry the factory Workplace identity. Production Cell projections always
 * populate task.metadata.workplace_ref; those desks are physically isolated by
 * the exact ref before any inheritance is attempted.
 */
export interface WorkplaceDesk {
  readonly workplaceRef: string | null;
  readonly nodeId: string;
  readonly profileId: string;
  readonly moduleRef: string;

  readonly trackerPath: string;
  readonly trackerAbsolutePath: string;
  readonly executionDirectory: string;

  readonly callFiles: readonly string[];
  readonly checklists: readonly string[];

  readonly recoveryFeedback: { readonly present: boolean; readonly path: string | null };
  readonly reviewFeedback: { readonly present: boolean; readonly path: string | null };
  readonly agentAssistance: { readonly required: boolean; readonly path: string | null };

  readonly workspaceFiles: readonly string[];
  readonly agentAssistanceAbsolutePath?: string;
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

  readonly repositoryDesk?: RepositoryDesk;
}

export function assertDeskInvariants(desk: WorkplaceDesk): void {
  const expectedTrackerSuffix = `node-${desk.nodeId}.md`;
  if (!desk.trackerAbsolutePath.endsWith(expectedTrackerSuffix)) {
    throw new Error(
      `WORKPLACE_DESK_TRACKER_NOT_NODE_STABLE: trackerAbsolutePath `
      + `'${desk.trackerAbsolutePath}' must end with '${expectedTrackerSuffix}' `
      + `(nodeId='${desk.nodeId}').`,
    );
  }
  const expectedDirSegment = `node-${desk.nodeId}`;
  if (!desk.executionDirectory.includes(expectedDirSegment)) {
    throw new Error(
      `WORKPLACE_DESK_DIR_NOT_NODE_KEYED: executionDirectory `
      + `'${desk.executionDirectory}' must include '${expectedDirSegment}'.`,
    );
  }
  if (desk.workplaceRef !== null) {
    const segment = workplacePathSegment(desk.workplaceRef);
    if (!desk.executionDirectory.includes(segment)) {
      throw new Error(
        `WORKPLACE_DESK_IDENTITY_SCOPE_MISMATCH: executionDirectory `
        + `'${desk.executionDirectory}' does not contain '${segment}' for `
        + `workplace '${desk.workplaceRef}'`,
      );
    }
    if (!desk.trackerAbsolutePath.includes(segment)) {
      throw new Error(
        `WORKPLACE_DESK_TRACKER_SCOPE_MISMATCH: tracker '${desk.trackerAbsolutePath}' `
        + `does not belong to workplace '${desk.workplaceRef}'`,
      );
    }
  }
  if (desk.agentAssistance.required && desk.agentAssistance.path === null) {
    throw new Error(
      `WORKPLACE_DESK_ASSISTANCE_REQUIRED_BUT_MISSING: pinned module declares `
      + `assistance for node '${desk.nodeId}' but no agent-assistance.json path was materialized.`,
    );
  }
  if (desk.recoveryFeedback.present && desk.recoveryFeedback.path === null) {
    throw new Error(
      `WORKPLACE_DESK_RECOVERY_PRESENT_BUT_NO_PATH: recoveryFeedback.present `
      + `is true for node '${desk.nodeId}' but path is null.`,
    );
  }
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

export interface MaterializePinnedWorkspaceRequest {
  readonly projection: WorkspaceProjection;
  readonly storedPackage: StoredModulePackage;
  readonly workspaceRoot: string;
  readonly module: ProcessModuleDefinition;
  readonly profile: ExecutionProfileDefinition;
  readonly projectId: number;
  readonly epicId: number;
  readonly task: ProcessExecutionWorkspaceTask;
  readonly executionId: string | null;
  readonly workerId: string;
  readonly additionalBindings?: Readonly<Record<string, unknown>>;
  readonly templatePreparer?: ProcessWorkspaceTemplatePreparer;
}

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
  const exact = projection.allResources.find(r => r.relativePath === declaredPath);
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

function workplaceRefFromMetadata(metadata: Record<string, unknown>): string | null {
  const ref = metadata.workplace_ref;
  return typeof ref === 'string' && ref.trim().length > 0 ? ref.trim() : null;
}

function workplacePathSegment(workplaceRef: string): string {
  return `workplace-${createHash('sha256').update(workplaceRef).digest('hex').slice(0, 24)}`;
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

  if (candidates.length === 0) {
    return `profile:${module.identity.kind}:${profile.id}`;
  }

  throw new Error(
    `AGENT_ASSISTANCE_NODE_AMBIGUOUS: profile '${profile.id}' maps to `
    + `${candidates.length} LM nodes`,
  );
}

export function materializePinnedWorkspace(
  request: MaterializePinnedWorkspaceRequest,
): WorkplaceDesk {
  const { projection, storedPackage, module, profile, task } = request;
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const stage = module.identity.kind;
  const metadata = parseMetadata(task.metadata);
  const nodeId = resolveOwningNodeId(module, profile, metadata);
  const workplaceRef = workplaceRefFromMetadata(metadata);

  const stageRoot = path.join(workspaceRoot, 'docs', stage);
  const projectDirectory = path.join(stageRoot, 'projects', String(request.epicId));
  const nodeDirectory = path.join(projectDirectory, 'executions', `node-${nodeId}`);
  const workplaceDirectory = workplaceRef === null
    ? nodeDirectory
    : path.join(nodeDirectory, workplacePathSegment(workplaceRef));
  const executionDirectory = path.join(
    workplaceDirectory,
    executionPathSegment(request.executionId, request.workerId),
  );
  const toolsDirectory = path.join(executionDirectory, 'tools');
  mkdirSync(workplaceDirectory, { recursive: true });
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

  let recoveryFeedbackPath: string | null = null;
  const recoveryFeedback = recoveryFeedbackFromMetadata(metadata);
  if (recoveryFeedback) {
    recoveryFeedbackPath = path.join(executionDirectory, 'recovery-feedback.json');
    writeFileSync(recoveryFeedbackPath, `${JSON.stringify(recoveryFeedback, null, 2)}\n`);
  }

  let reviewFeedbackPath: string | null = null;
  const reviewFeedback = reviewFeedbackFromMetadata(metadata);
  if (reviewFeedback) {
    reviewFeedbackPath = path.join(executionDirectory, 'review-feedback.json');
    writeFileSync(reviewFeedbackPath, `${JSON.stringify(reviewFeedback, null, 2)}\n`);
  }

  const workspaceTemplates = profile.workspaceTemplates ?? [];
  const callTemplates = profile.callTemplates ?? [];
  const checklists = profile.checklists ?? [];

  // Retry inheritance is now bounded by the exact Workplace directory. Legacy
  // tasks without workplace_ref retain the historical node-scoped behavior.
  // This removes cross-workKey contamination immediately. A later DeskSnapshot
  // cutover can replace within-Workplace mtime ordering with an explicit parent
  // snapshot without changing the physical identity again.
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

  if (!profile.trackerTemplate) {
    throw new Error(`PROCESS_WORKSPACE_TRACKER_MISSING: profile '${profile.id}' has no tracker template`);
  }
  const trackerSourceContent = readPinnedText(
    projection,
    storedPackage,
    profile.trackerTemplate,
  );
  const trackerDirectory = workplaceRef === null
    ? executionDirectory
    : workplaceDirectory;
  const trackerAbsolutePath = path.join(
    trackerDirectory,
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

  const assistanceDefinitions = storedPackage.manifest.assistance ?? [];
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
    workplaceRef,
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
    workspaceFiles: [
      ...workspaceTemplates.map(a => materializedBySource.get(a)).filter((v): v is string => !!v),
      ...(recoveryFeedbackRelative ? [recoveryFeedbackRelative] : []),
      ...(reviewFeedbackRelative ? [reviewFeedbackRelative] : []),
    ],
    ...(agentAssistanceAbsolutePath ? { agentAssistanceAbsolutePath } : {}),
  };
  assertDeskInvariants(desk);
  return desk;
}
