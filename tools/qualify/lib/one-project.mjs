#!/usr/bin/env node
/**
 * tools/qualify/lib/one-project.mjs - the child entry of the concurrency
 * proofs (WP-15): runs EXACTLY ONE corpus project in its own process, under
 * isolated paths, and writes a compact result document.
 *
 * Usage: node tools/qualify/lib/one-project.mjs --project <id> --out <result.json>
 */

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
};

const { descriptorOf } = await import(pathToFileURL(join(REPO_ROOT, 'tests', 'project-corpus', 'registry.mjs')).href);
const { runProject } = await import(pathToFileURL(join(REPO_ROOT, 'tools', 'project-corpus', 'lib', 'execute.mjs')).href);

const descriptor = await descriptorOf(value('project'));
const startedAt = Date.now();
const result = await runProject(descriptor);
writeFileSync(value('out'), `${JSON.stringify({
  projectId: descriptor.projectId,
  capsuleId: descriptor.scenario.identity.capsuleId,
  status: result.status,
  elapsedMs: Date.now() - startedAt,
  checksGreen: `${result.checks.filter((check) => check.status === 'green').length}/${result.checks.length}`,
  traceFingerprint: result.observed === null ? null : JSON.stringify(result.observed.summary),
  receiptWorld: result.observed === null ? null : result.observed.receiptWorld,
  redChecks: result.checks.filter((check) => check.status === 'red').map((check) => ({ id: check.id, detail: check.detail })),
  pid: process.pid,
}, null, 2)}\n`, 'utf8');
process.exit(result.status === 'green' ? 0 : 1);
