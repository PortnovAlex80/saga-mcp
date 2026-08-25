#!/usr/bin/env node
// EK-1 admission-spec validator — the unified blocking entry point
// (coordinator-owned; package.json: validate:ek-admission-specs).
// Runs the three specification validators + the complexity measurement
// driver + the transition-universe validator, then computes the
// admissionContractDigest per the plan:
//   H(canonical(specificationDigests, validatorDigest, mutationCorpusDigest))
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = path.join(ROOT, 'docs/refactoring/event-kernel/specs');
const RECON = path.join(ROOT, 'docs/refactoring/event-kernel/reconciliation');
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const run = (cmd, args) => {
  const r = execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return r;
};

const steps = [
  ['complexity driver (diagnostic baseline mode)', () => run('node', [path.join(SPECS, 'measure-complexity.mjs'), '--out', path.join(SPECS, '.ek-admission-vector.json')])],
  ['complexity budget selftest', () => run('node', [path.join(SPECS, 'measure-complexity.mjs'), '--selftest'])],
  ['role-contract validator', () => run('node', [path.join(SPECS, 'validate-role-contract.mjs')])],
  ['prompt-budget validator', () => run('node', [path.join(SPECS, 'validate-prompt-budget.mjs')])],
  ['transition-universe validator', () => run('node', [path.join(RECON, 'validate-transition-universe.mjs')])],
];
for (const [name, fn] of steps) { const out = fn(); console.log(`[ek-admission] ${name}: ${String(out).trim().split('\n').pop().slice(0, 120)}`); }

const specFiles = {
  complexityBudget: path.join(SPECS, 'complexity-budget.json'),
  complexityDriver: path.join(SPECS, 'measure-complexity.mjs'),
  roleContractSchema: path.join(SPECS, 'canonical-role-contract.schema.json'),
  roleManifest: path.join(SPECS, 'role-contract-manifest.json'),
  roleValidator: path.join(SPECS, 'validate-role-contract.mjs'),
  promptBudgetSchema: path.join(SPECS, 'prompt-budget-profile.schema.json'),
  contextClassification: path.join(SPECS, 'context-source-classification.json'),
  promptValidator: path.join(SPECS, 'validate-prompt-budget.mjs'),
  transitionUniverse: path.join(RECON, 'transition-universe.json'),
};
const digests = Object.fromEntries(Object.entries(specFiles).map(([k, f]) => [k, sha256(f)]));
const selfDigest = sha256(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const canonical = JSON.stringify({ digests, validator: selfDigest }, Object.keys({ digests, validator: selfDigest }).sort());
const admissionContractDigest = createHash('sha256').update(canonical).digest('hex');
console.log(`[ek-admission] ALL GREEN`);
console.log(JSON.stringify({ specificationDigests: digests, validatorDigest: selfDigest, admissionContractDigest }, null, 2));
