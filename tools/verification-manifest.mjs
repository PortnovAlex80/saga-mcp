#!/usr/bin/env node
// tools/verification-manifest.mjs
//
// K1 commit 4/5 of the Saga Core Renewal program — same-SHA verification
// manifest for the canonical suite set.
//
//   node tools/verification-manifest.mjs --run     execute every canonical
//                                                   suite and write
//                                                   docs/verification/verification-manifest.json
//                                                   bound to the CURRENT SHA
//   node tools/verification-manifest.mjs --check   fail unless a stored
//                                                   manifest exists, names
//                                                   the current SHA, and
//                                                   records every canonical
//                                                   suite green
//
// The canonical suites are the K1 green baseline: build, factory ratchet,
// architecture, factory-contract, golden path, factory-temporal,
// factory-model, and the migration smoke set. A release claims a green
// baseline only through this manifest on its exact merge SHA (ADR-076
// evidence rule 8: proof attaches to the exact commit).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'docs/verification/verification-manifest.json');

const CANONICAL_SUITES = [
  { id: 'build', command: 'npm run build' },
  { id: 'factory-ratchet', command: 'npm run test:factory:ratchet' },
  { id: 'architecture', command: 'npm run test:architecture' },
  { id: 'factory-contract', command: 'npm run test:factory-contract' },
  { id: 'golden-path', command: 'npm run test:golden-path' },
  { id: 'factory-temporal', command: 'npm run test:factory-temporal' },
  { id: 'factory-model', command: 'npm run test:factory-model' },
  {
    id: 'migration-smoke',
    command: 'node --test tests/app/engine-watchdog-migration.test.mjs tests/app/operator-soft-stop-migration.test.mjs tests/architecture/v4-target-conformance-ratchet.test.mjs',
  },
];

function currentSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
}

function parseTestSummary(output) {
  const pass = Number(output.match(/^ℹ pass (\d+)/m)?.[1] ?? '0');
  const fail = Number(output.match(/^ℹ fail (\d+)/m)?.[1] ?? '0');
  const tests = Number(output.match(/^ℹ tests (\d+)/m)?.[1] ?? '0');
  return { tests, pass, fail };
}

function runOne(suite) {
  const started = Date.now();
  const [cmd, ...rest] = suite.command.split(' ');
  const result = spawnSync(cmd, rest, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const summary = parseTestSummary(output);
  const entry = {
    id: suite.id,
    command: suite.command,
    exitCode: result.status,
    durationMs: Date.now() - started,
  };
  if (summary.tests > 0) entry.tests = summary;
  return entry;
}

function writeManifest() {
  const sha = currentSha();
  const suites = CANONICAL_SUITES.map(runOne);
  const manifest = {
    schemaVersion: 1,
    kind: 'saga-core-renewal-green-baseline',
    sha,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    recordedAt: new Date().toISOString(),
    suites,
    allGreen: suites.every((s) => s.exitCode === 0),
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`verification manifest: sha=${sha.slice(0, 12)} allGreen=${manifest.allGreen}\n`);
  for (const s of suites) {
    process.stdout.write(
      `  ${s.exitCode === 0 ? 'PASS' : 'FAIL'} ${s.id} (${(s.durationMs / 1000).toFixed(1)}s`
      + (s.tests ? `, ${s.tests.pass}/${s.tests.tests} tests` : '') + ')\n',
    );
  }
  if (!manifest.allGreen) process.exitCode = 1;
}

function checkManifest() {
  if (!existsSync(manifestPath)) {
    process.stderr.write(`verification manifest missing: ${manifestPath}\n`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const sha = currentSha();
  const failures = [];
  if (manifest.sha !== sha) {
    // A green proof transfers across a commit only when that commit changes
    // nothing executable — docs and the registry itself. Anything else
    // requires regenerating the manifest on the new SHA.
    let changed = [];
    try {
      changed = execFileSync('git', ['diff', '--name-only', `${manifest.sha}..HEAD`], { cwd: repoRoot })
        .toString().split(/\r?\n/).filter(Boolean);
    } catch {
      changed = ['<unresolvable-diff>'];
    }
    const nonDocs = changed.filter((p) => !p.startsWith('docs/'));
    if (nonDocs.length > 0) {
      failures.push(`manifest sha ${manifest.sha?.slice(0, 12)} != HEAD ${sha.slice(0, 12)} and non-docs files changed since: ${nonDocs.join(', ')} — regenerate with --run on this commit`);
    }
  }
  if (!manifest.allGreen) failures.push('manifest records a non-green suite');
  for (const suite of CANONICAL_SUITES) {
    if (!manifest.suites?.some((s) => s.id === suite.id && s.exitCode === 0)) {
      failures.push(`suite "${suite.id}" missing or not green in manifest`);
    }
  }
  if (failures.length > 0) {
    process.stderr.write(`verification manifest check FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`verification manifest OK for ${sha.slice(0, 12)} (${manifest.suites.length} suites green)\n`);
}

const mode = process.argv[2];
if (mode === '--run') writeManifest();
else if (mode === '--check') checkManifest();
else {
  process.stderr.write('usage: node tools/verification-manifest.mjs --run | --check\n');
  process.exitCode = 2;
}
