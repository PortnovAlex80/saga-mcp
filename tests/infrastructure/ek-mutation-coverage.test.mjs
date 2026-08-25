// WP-13C / EK-9 — mutation-coverage harness hosting (CI-blocking wrapper).
//
// tools/ek-mutation-coverage.mjs is the kernel mutation-coverage harness; the
// mutation demonstrations live in the ONE central registry
// (tests/infrastructure/ek-mutation-registry.mjs — see its header for the
// convention and why the data sits there, not beside the harness). The
// harness applies every registered RED/GREEN demonstration as a real source
// patch (temp workspace copy — the real tree is never touched) and requires
// the owning suite to flip RED. This suite hosts the harness BLOCKING in the
// acceptance matrix:
//
//   MC1 the registry is well-formed and non-vacuous (unique ids, >= 6
//       declared mutations across >= 3 kernel suites — the domain-model,
//       application and development suites at minimum);
//   MC2 the harness run over the FULL registry is green: every baseline
//       suite green unmutated, every mutation KILLED (suite red when the
//       defect is applied), zero survivors, zero anchor-rot entries
//       (a registry find-string that no longer matches the compiled output
//       is blocking — mutation demonstrations cannot rot into vacuous
//       green).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = path.join(ROOT, 'tools', 'ek-mutation-coverage.mjs');

function runHarness(...flags) {
  const r = spawnSync(process.execPath, [HARNESS, ...flags], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('MC1: the mutation registry is well-formed and covers the domain-model, application and development suites', () => {
  const r = runHarness('--list');
  assert.equal(r.status, 0, `--list must exit 0:\n${r.out}`);
  const ids = [...r.out.matchAll(/^(\S+)  \[tests\//gm)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `expected >=6 registered mutations, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, 'mutation ids must be unique');
  const suites = [...r.out.matchAll(/\[(tests\/[^\]]+)\]/g)].map((m) => m[1]);
  for (const required of [
    'tests/workflow-kernel/model/mutations.test.mjs',
    'tests/workflow-kernel/application/consumer.test.mjs',
    'tests/workflow-kernel/development/mutations.test.mjs',
  ]) {
    assert.ok(suites.includes(required), `the registry must cover ${required}`);
  }
});

test('MC2: every registered mutation is KILLED (baseline green -> patched red), zero survivors, zero anchor rot', () => {
  const r = runHarness('--json');
  assert.equal(r.status, 0, `the harness must be green over the full registry:\n${r.out.slice(0, 4000)}`);
  const j = JSON.parse(r.out);
  assert.ok(j.summary.green === true, 'harness summary must be green');
  assert.equal(j.summary.survivors.length, 0, `surviving mutations: ${JSON.stringify(j.summary.survivors)}`);
  assert.equal(j.summary.killed, j.summary.ran, 'every ran mutation must be killed');
  assert.ok(j.summary.killed >= 6, `expected >=6 kills, got ${j.summary.killed}`);
  for (const res of j.results) {
    assert.ok(res.outcome === 'KILLED' || res.outcome === 'BASELINE-GREEN',
      `unexpected outcome ${res.outcome} for ${res.id}: ${res.detail}`);
  }
  // belt-and-braces: the human output names the count
  const human = runHarness();
  assert.equal(human.status, 0);
  assert.match(human.out, /ALL REGISTERED MUTATIONS KILLED/);
});
