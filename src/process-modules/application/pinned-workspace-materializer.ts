/**
 * Pinned-package workspace materializer (SPI cutover Seam C).
 *
 * Replaces the legacy `safeAssetPath(workspaceRoot, asset)` resource lookup in
 * `prepareProcessExecutionWorkspace` with a pinned-package source: reads bytes
 * from the immutable content-addressed store (`WorkspaceProjection.storeLocation`
 * + resource `absolutePath`) instead of the project workspace tree. This closes
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
 *   pinned:  resolveResourceAbsolute(projection, assetPath) → reads from
 *            projection.allResources[].absolutePath (storeLocation-rooted POSIX)
 *
 * On Windows the projection's absolutePath is POSIX (forward slashes); the fs
 * edge normalizes via path.resolve before readFileSync.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Input to the pinned-package materializer. Mirrors the legacy request shape,
 * but the resource source is the pre-resolved WorkspaceProjection (bytes live
 * under projection.storeLocation) rather than workspaceRoot-relative assets.
 */
export interface MaterializePinnedWorkspaceRequest {
  /** The pinned-package projection (skills/templates/checklists/tracker). */
  readonly projection: WorkspaceProjection;
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
}

/**
 * Resolve a module-relative resource path (as declared in the profile, e.g.
 * `src/.../package/resources/proposal-stage-tracker.md` OR a package-relative
 * `proposal-stage-tracker.md`) to its pinned-store absolutePath via the
 * projection's allResources. Matches by exact relativePath, then by basename.
 *
 * The profile's trackerTemplate/workspaceTemplates/callTemplates/checklists
 * historically carried repo-root-relative POSIX paths (post-migration). The
 * projection's resourceIndex entries carry the same paths verbatim (the
 * installer does not rewrite them), so an exact match is the common case.
 * Basename fallback covers package-relative profile pointers.
 */
function resolveResourceAbsolute(
  projection: WorkspaceProjection,
  declaredPath: string,
): string {
  // Exact relativePath match.
  const exact = projection.allResources.find(r => r.relativePath === declaredPath);
  if (exact) return exact.absolutePath;
  // Basename fallback.
  const base = path.posix.basename(declaredPath);
  const byBase = projection.allResources.find(r => path.posix.basename(r.relativePath) === base);
  if (byBase) return byBase.absolutePath;
  throw new Error(
    `PINNED_RESOURCE_NOT_IN_PACKAGE: profile references '${declaredPath}' but the pinned `
    + `installation ${projection.installationId} (${projection.moduleRef}) has no resource `
    + `with that path or basename. Declared resources: `
    + projection.allResources.map(r => r.relativePath).join(', '),
  );
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
  const { projection, module, profile, task } = request;
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const stage = module.identity.kind;

  // 1. Target directory physics — identical to legacy.
  const stageRoot = path.join(workspaceRoot, 'docs', stage);
  const toolsDirectory = path.join(stageRoot, 'tools');
  const projectDirectory = path.join(stageRoot, 'projects', String(request.epicId));
  const executionDirectory = path.join(projectDirectory, 'executions', `task-${task.id}`);
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
  });
  const metadata = parseMetadata(task.metadata);

  // 2. recovery-feedback.json — always overwritten (machine-owned, no retry preserve).
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

  // 4. Stage shared copies into tools/ — first-writer-wins (idempotent).
  const allAssets = [...new Set([
    ...(profile.trackerTemplate ? [profile.trackerTemplate] : []),
    ...workspaceTemplates,
    ...callTemplates,
    ...checklists,
  ])];
  for (const asset of allAssets) {
    const source = path.resolve(resolveResourceAbsolute(projection, asset));
    if (!existsSync(source)) {
      throw new Error(
        `PINNED_RESOURCE_BYTES_MISSING: '${asset}' resolved to '${source}' in store `
        + `${projection.storeLocation} but the file is absent (corrupt package store?).`,
      );
    }
    const sharedTarget = path.join(toolsDirectory, path.basename(asset));
    if (!existsSync(sharedTarget)) {
      writeFileSync(sharedTarget, readFileSync(source, 'utf8'));
    }
  }

  // 5. Materialize workspace + call templates into executionDirectory/ with
  //    retry-idempotency (reuse the legacy helpers verbatim).
  const materializedBySource = new Map<string, string>();
  for (const asset of [...new Set([...workspaceTemplates, ...callTemplates])]) {
    const source = path.resolve(resolveResourceAbsolute(projection, asset));
    const target = path.join(executionDirectory, materializedName(asset));
    const sourceContent = readFileSync(source, 'utf8');
    if (!existsSync(target)) {
      const prepared = path.extname(target).toLowerCase() === '.json'
        ? refreshJsonMachineBindings(sourceContent, bindings)
        : fillKnownPlaceholders(sourceContent, bindings);
      writeFileSync(target, prepared);
    } else if (path.extname(target).toLowerCase() === '.json') {
      // Retry: preserve semantic work, refresh only execution-scoped fields.
      const existing = readFileSync(target, 'utf8');
      writeFileSync(target, refreshJsonMachineBindings(existing, bindings));
    }
    materializedBySource.set(asset, relativeWorkspacePath(workspaceRoot, target));
  }

  // 6. Tracker — materialize into projectDirectory with the exact legacy
  //    filename pattern (consumers depend on it). Retry reads existing file
  //    so worker checkpoint edits survive.
  if (!profile.trackerTemplate) {
    throw new Error(`PROCESS_WORKSPACE_TRACKER_MISSING: profile '${profile.id}' has no tracker template`);
  }
  const trackerSource = path.resolve(resolveResourceAbsolute(projection, profile.trackerTemplate));
  if (!existsSync(trackerSource)) {
    throw new Error(
      `PINNED_RESOURCE_BYTES_MISSING: tracker '${profile.trackerTemplate}' resolved to `
      + `'${trackerSource}' but the file is absent.`,
    );
  }
  const trackerAbsolutePath = path.join(
    projectDirectory,
    `project-${request.epicId}-${stage}-stage-${task.id}.md`,
  );
  if (!existsSync(trackerAbsolutePath)) {
    const tracker = refreshMarkdownMachineBindings(
      readFileSync(trackerSource, 'utf8'),
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

  // 7. Return the same shape consumers already depend on.
  return {
    profileId: profile.id,
    moduleRef: `${module.identity.name}@${module.identity.version}`,
    trackerPath: relativeWorkspacePath(workspaceRoot, trackerAbsolutePath),
    trackerAbsolutePath,
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
