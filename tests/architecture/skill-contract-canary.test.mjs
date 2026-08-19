/**
 * BLINDSIGHT X2 canary — phantom skill contracts cannot respawn silently.
 *
 * Census (docs/factory-run/stage11/PREVENTIVE-HUNT.md, Cross-Layer X2):
 * six skills promised a memory bridge (metadata.previous_failures,
 * metadata.attempt_history, metadata.hint, RECOVERY:-prefix parsing) that had
 * ZERO implementations. Workers followed a contract that did not exist.
 *
 * Contract of this canary:
 *
 *   1. Every skill mention of a BRIDGED contract token must map to live
 *      implementation evidence in src/ (grep correspondence). Deleting the
 *      bridge while the skills still promise it fails here.
 *   2. FORBIDDEN tokens (phantom helpers/columns that were removed) must have
 *      ZERO mentions anywhere under skills/. Re-adding one fails here.
 *   3. The bridge surface itself (src/lifecycle/task-recovery-memory.ts) must
 *      stay wired into both decision points: the comment_add handler and the
 *      claim path. An unwired bridge module is a dead-code phantom of a
 *      different color and also fails here.
 *
 * Adding a NEW promised field to a skill? Add it to BRIDGED_CONTRACTS with its
 * implementation file, or do not promise it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const skillsRoot = path.join(repoRoot, 'skills');

/**
 * Bridged contract tokens: [token, implementation file, required literal].
 * A token may appear in skills only while its implementation evidence exists.
 */
const BRIDGED_CONTRACTS = [
  ['metadata.previous_failures', 'src/lifecycle/task-recovery-memory.ts', 'previous_failures'],
  ['metadata.attempt_history', 'src/lifecycle/task-recovery-memory.ts', 'attempt_history'],
  ['metadata.hint', 'src/lifecycle/task-recovery-memory.ts', 'metadata.hint'],
  ['RECOVERY:', 'src/lifecycle/task-recovery-memory.ts', 'RECOVERY_COMMENT_PREFIX'],
  ['recovery_summary', 'src/lifecycle/task-recovery-memory.ts', 'recovery_summary'],
];

/**
 * Phantom tokens that were removed with this repair. They must never come
 * back without a real implementation (and a registry entry above).
 */
const FORBIDDEN_TOKENS = [
  // Never existed: a "helper B1" referenced by perf-tuner/type-fixer while
  // the documented task_update({metadata:{hint}}) call would have REPLACED
  // the whole task metadata (destroying process_run_id).
  'patchTaskMetadata',
  // Never existed: worker_executions has no attempt_history column; the
  // durable attempt log lives in tasks.metadata.attempt_history.
  'worker_executions.attempt_history',
];

/** Wiring points: the bridge must be called from these files. */
const WIRING_POINTS = [
  ['src/tools/comments.ts', 'materializeTaskRecoveryMemory'],
  ['src/lifecycle/work-assignment-core.ts', 'materializeTaskRecoveryMemory'],
];

function listSkillFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSkillFiles(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const skillFiles = listSkillFiles(skillsRoot);
assert.ok(skillFiles.length > 0, 'skills/ must contain markdown files');

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function mentionsInSkills(token) {
  const hits = [];
  for (const file of skillFiles) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(token)) hits.push(toPosix(path.relative(repoRoot, file)));
  }
  return hits;
}

test('skills dir exposes the memory-bridge contract files', () => {
  const relative = skillFiles.map(f => toPosix(path.relative(repoRoot, f)));
  for (const expected of [
    'skills/saga-verifier/SKILL.md',
    'skills/saga-perf-tuner/SKILL.md',
  ]) {
    assert.ok(relative.includes(expected), `${expected} must exist`);
  }
});

test('every bridged contract mention maps to live implementation evidence', () => {
  for (const [token, implRel, needle] of BRIDGED_CONTRACTS) {
    const mentionedIn = mentionsInSkills(token);
    const implAbs = path.join(repoRoot, implRel);
    if (!existsSync(implAbs)) {
      assert.fail(
        `Phantom contract: '${token}' is promised by ${JSON.stringify(mentionedIn)} `
        + `but implementation file ${implRel} does not exist. `
        + 'Either implement the bridge or remove the promise from the skills.',
      );
    }
    const implSource = readFileSync(implAbs, 'utf8');
    assert.ok(
      implSource.includes(needle),
      `Stale contract: '${token}' is promised by ${JSON.stringify(mentionedIn)} `
      + `but ${implRel} no longer contains '${needle}'.`,
    );
  }
});

test('forbidden phantom tokens have zero mentions in skills', () => {
  for (const token of FORBIDDEN_TOKENS) {
    const mentionedIn = mentionsInSkills(token);
    assert.deepEqual(
      mentionedIn,
      [],
      `Phantom token '${token}' reappeared in skills. It has no implementation. `
      + 'Remove the mention or implement the contract and register it in '
      + 'BRIDGED_CONTRACTS of this canary.',
    );
  }
});

test('the bridge module stays wired into comment_add and the claim path', () => {
  for (const [wiringRel, needle] of WIRING_POINTS) {
    const wiringAbs = path.join(repoRoot, wiringRel);
    assert.ok(existsSync(wiringAbs), `${wiringRel} must exist`);
    const source = readFileSync(wiringAbs, 'utf8');
    assert.ok(
      source.includes(needle),
      `${wiringRel} must call ${needle} — an unwired bridge is dead code.`,
    );
  }
});

test('no skill promises an unregistered memory-family metadata field', () => {
  const registered = new Set(BRIDGED_CONTRACTS.map(([token]) => token));
  const familyPattern = /metadata\.(previous_failures|attempt_history|hint)\b/g;
  const offenders = new Map();
  for (const file of skillFiles) {
    const text = readFileSync(file, 'utf8');
    let match;
    while ((match = familyPattern.exec(text)) !== null) {
      const token = match[0];
      if (!registered.has(token) && !offenders.has(token)) {
        offenders.set(token, path.relative(repoRoot, file));
      }
    }
  }
  assert.deepEqual(
    [...offenders.keys()],
    [],
    `Unregistered memory-family fields promised by skills: ${JSON.stringify([...offenders])}. `
    + 'Register them with implementation evidence or remove the mention.',
  );
});
