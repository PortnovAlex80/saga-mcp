/**
 * Pure workspace-seeding logic for one discovery epic. Extracted from
 * saga3-discovery-engine.ensureDiscoveryWorkspace so it can be unit-tested
 * without spinning up the whole engine (the engine delegates here).
 *
 * Responsibilities (all idempotent — restart-safe, skips existing files):
 *   1. Copy ALL static templates from tool-templates/discovery/ into
 *      docs/discovery/tools/ (workers read templates from there).
 *   2. Create docs/discovery/project-<epic>-discovery-stage.md from
 *      stage-tracker.md with epic_id/task_id/project_id pre-filled.
 *   3. Create docs/discovery/proposal-call-<epic>.json from
 *      proposal-call-template.json with intent_id/task_id pre-filled.
 *
 * Regression context: this logic existed as engine.ensureDiscoveryWorkspace
 * (commit 1efb086), was deleted in 12952be when templates became static, and
 * the deletion went uncaught because NO test covered workspace creation.
 * tests/saga3/d1-workspace-creation.test.mjs now guards it.
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

  const tmplDir = path.join(workspaceRoot, 'tool-templates', 'discovery');
  if (!existsSync(tmplDir)) {
    result.templatesDirMissing = true;
    return result;
  }

  const destDir = path.join(workspaceRoot, 'docs', 'discovery');
  const toolsDir = path.join(destDir, 'tools');
  try {
    mkdirSync(destDir, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });
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

  // 2. Per-epic stage tracker.
  const trackerDest = path.join(destDir, `project-${epicId}-discovery-stage.md`);
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
  const proposalDest = path.join(destDir, `proposal-call-${epicId}.json`);
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
