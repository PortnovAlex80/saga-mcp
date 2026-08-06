/**
 * ============================================================================
 * ⚠️  DO NOT DELETE / GUT THIS MODULE — regression guard.
 * ============================================================================
 * This logic existed as engine.ensureDiscoveryWorkspace (commit 1efb086) and
 * was DELETED in 12952be ("templates became static, engine no longer touches
 * the filesystem"). That deletion went UNCAUGHT because no test covered
 * workspace creation. The consequence surfaced 5 commits later on epic 33:
 *
 *   - docs/discovery/tools/ had to be seeded by hand and drifted out of sync
 *     (epic 33 was missing stage-tracker.md);
 *   - the per-epic stage tracker had to be created manually for every run;
 *   - the discovery worker had NO engine-fill for proposal-call-N.json
 *     (only readiness/diagnosis had one via ensureStageTemplate);
 *   - the diagnosis worker kept losing schema_version (clarity: it copied the
 *     raw template over the engine-filled file, dropping the top-level arg).
 *
 * If you think "the engine should not touch the filesystem" — you are right
 * in principle, but the discovery edition NEEDS per-epic workspace seeding
 * because weaker LM workers cannot reliably derive intent_id/task_id/
 * schema_version from task_get alone. Removing this module reintroduces the
 * regression. The regression test (tests/discovery/d1-workspace-creation.test.mjs)
 * WILL fail; do not delete the test either.
 *
 * If you want to relocate this logic (e.g. into the executor factory, or a
 * saga3 workspace service), MOVE it — do not just delete it. Keep the test
 * green.
 * ============================================================================
 *
 * Pure workspace-seeding logic for one discovery epic. Originally extracted
 * from the retired factory-discovery-engine.ensureDiscoveryWorkspace so it could
 * be unit-tested without spinning up the whole engine; the engine is gone
 * (saga4 cutover) but this logic is still invoked by the discovery workspace
 * materializer.
 *
 * Responsibilities (all idempotent — restart-safe, skips existing files):
 *   1. Copy ALL static templates from the discovery package resources
 *      directory (src/process-modules/modules/discovery/package/resources/)
 *      into docs/discovery/tools/ (workers read templates from there).
 *   2. Create docs/discovery/project-<epic>-discovery-stage.md from
 *      stage-tracker.md with epic_id/task_id/project_id pre-filled.
 *   3. Create docs/discovery/proposal-call-<epic>.json from
 *      proposal-call-template.json with intent_id/task_id pre-filled.
 *
 * Regression context: this logic existed as engine.ensureDiscoveryWorkspace
 * (commit 1efb086), was deleted in 12952be when templates became static, and
 * the deletion went uncaught because NO test covered workspace creation.
 * tests/discovery/d1-workspace-creation.test.mjs now guards it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface EnsureDiscoveryWorkspaceRequest {
  workspaceRoot: string;
  epicId: number;
  projectId: number;
  taskId: number;
  intentId: number;
}

/**
 * Result of seeding — which artifacts were created vs skipped (already existed).
 * Returned so tests can assert without re-reading the filesystem.
 */
export interface EnsureDiscoveryWorkspaceResult {
  toolsCopied: string[];
  toolsSkipped: string[];
  trackerCreated: boolean;
  proposalCallCreated: boolean;
  templatesDirMissing: boolean;
}

export function ensureDiscoveryWorkspace(
  request: EnsureDiscoveryWorkspaceRequest,
): EnsureDiscoveryWorkspaceResult {
  const { workspaceRoot, epicId, projectId, taskId, intentId } = request;
  const result: EnsureDiscoveryWorkspaceResult = {
    toolsCopied: [],
    toolsSkipped: [],
    trackerCreated: false,
    proposalCallCreated: false,
    templatesDirMissing: false,
  };

  // (`tool-templates/discovery/`) into the discovery package resources
  // directory. Resolve under workspaceRoot (repo root in production).
  const tmplDir = path.join(
    workspaceRoot,
    'src',
    'process-modules',
    'modules',
    'discovery',
    'package',
    'resources',
  );
  if (!existsSync(tmplDir)) {
    result.templatesDirMissing = true;
    return result;
  }

  // SHARED tools/ — copied once for all epics (templates are stage-static,
  // not epic-specific). Workers read templates from here.
  const discoveryRoot = path.join(workspaceRoot, 'docs', 'discovery');
  const toolsDir = path.join(discoveryRoot, 'tools');

  // PER-EPIC workspace — each epic gets its own folder for tracker,
  // discovery doc, *-call-N.json. This isolates one epic's artifacts from
  // another (regression proof: epic 35's worker read epic 34's discovery
  // doc and invented a 'relationship to epic 34' blocking gap that was not
  // a real product question). With per-project folders, a worker only sees
  // its own epic's workspace.
  const epicDir = path.join(discoveryRoot, 'projects', String(epicId));

  try {
    mkdirSync(discoveryRoot, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(epicDir, { recursive: true });
  } catch { /* dirs already exist */ }

  // 1. Copy ALL static templates into docs/discovery/tools/ (idempotent).
  //    stage-tracker.md is consumed below as the source for the per-epic
  //    tracker; skip copying the raw template into tools/ (workers read the
  //    per-epic tracker, not the raw template).
  try {
    for (const name of readdirSync(tmplDir)) {
      if (name === 'stage-tracker.md') continue;
      const target = path.join(toolsDir, name);
      if (existsSync(target)) {
        result.toolsSkipped.push(name);
        continue;
      }
      try {
        writeFileSync(target, readFileSync(path.join(tmplDir, name), 'utf8'));
        result.toolsCopied.push(name);
      } catch { /* best effort per file */ }
    }
  } catch { /* readdir failed — best effort */ }

  // 2. Per-epic stage tracker (in epicDir, NOT in discoveryRoot — isolates
  //    one epic's tracker from another).
  const trackerDest = path.join(epicDir, `project-${epicId}-discovery-stage.md`);
  if (!existsSync(trackerDest)) {
    const trackerSrc = path.join(tmplDir, 'stage-tracker.md');
    if (existsSync(trackerSrc)) {
      try {
        let content = readFileSync(trackerSrc, 'utf8');
        content = content.replace(/\{PROJECT_ID\}/g, String(projectId));
        content = content.replace(/\{EPIC_ID\}/g, String(epicId));
        content = content.replace(/\{TASK_ID\}/g, String(taskId));
        content = content.replace(/\{FILL_FROM_TASK_GET_METADATA_WORK_INTENT_ID\}/g, String(intentId));
        writeFileSync(trackerDest, content);
        result.trackerCreated = true;
      } catch { /* best effort */ }
    }
  }

  // 3. Per-epic proposal-call JSON (engine-fill for the discovery stage).
  //    Lives in epicDir so the worker only sees its own epic's binding.
  const proposalDest = path.join(epicDir, `proposal-call-${epicId}.json`);
  if (!existsSync(proposalDest)) {
    const proposalSrc = path.join(tmplDir, 'proposal-call-template.json');
    if (existsSync(proposalSrc)) {
      try {
        let content = readFileSync(proposalSrc, 'utf8');
        const sub = (key: string, val: unknown) => {
          const regex = new RegExp(`"FILL_[^"]*${key.toUpperCase()}[^"]*"`, 'gi');
          content = content.replace(regex, JSON.stringify(val));
        };
        sub('intent_id', intentId);
        sub('task_id', taskId);
        writeFileSync(proposalDest, content);
        result.proposalCallCreated = true;
      } catch { /* best effort */ }
    }
  }

  return result;
}
