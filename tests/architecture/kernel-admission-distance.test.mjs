// tests/architecture/kernel-admission-distance.test.mjs
//
// ADR-082 — the kernel admission boundary, frozen by exact counts.
//
// WHAT THIS MEASURES. "Admission distance" is the number of deliberate edits
// inside the kernel repository required to plug in a new workshop (ADR-082 §2):
// Tier 1 (text with review) needs 0 kernel edits, Tier 2 (deterministic
// computation via qualified providers) 1–2, Tier 3 (code, with a git candidate
// and runnability) 3–4. Those edits land on exactly the four surfaces frozen
// below. This test pins TODAY's numbers so a new admission point cannot appear
// by quiet drift: it must be added here, in the same commit as the admission it
// accounts for, and that commit message must state the admission (ADR-082 §4).
//
// WHY EXACT COUNTS, NOT LOWER BOUNDS. A `>=` bound lets the surface grow
// silently — which is precisely the failure this ratchet exists to catch.
// Raising a frozen number is legitimate and expected: do it deliberately, in
// the same commit as the admission it accounts for.
//
// WHO OPENS THIS BOUNDARY. Nobody, before Controlled Change Plane release C12
// — the Semantic Adapter SDK (docs/vision/CONTROLLED-CHANGE-PLANE-PLAN.md:671),
// whose exit gate is "a minimal second fixture pack passes the conformance
// kit". Until then a composite capability manifest, a package-shipped kernel
// handler, or a second accepted lifecycle input schema are all forbidden
// (ADR-082 §5).
//
// THE BEHAVIOURAL SCAN (sections 5–6 below) pins a second, independent
// invariant: the kernel must not branch on a workshop/stage name. The
// 2026-08-18 audit (docs/research/2026-08-18-kernel-surface-evidence-development-chain.md
// §6) blessed exactly one behavioural site — the `linkType` ternary in
// sqlite-production-cell-projection-persistence, owned by K15 (unified
// vocabulary) and C5 (the trace model owns edge types): report it, never fix
// it. A re-sweep done for THIS test found additional behavioural sites the
// audit had missed (git archaeology shows they predate it — audit misses, not
// post-audit drift). They are recorded in DRIFT_REPORTED below — explicitly,
// not silently allowlisted — and were escalated to the architect with the
// stage-4 report. When the architect adjudicates a drift entry it moves into
// BENIGN_NAME_DATA (accepted as data, not behaviour) or the code changes under
// K15/C5; either way this file changes in that same commit.
//
// IF THIS TEST GOES RED you either (a) added an admission point — bump the
// frozen numbers in the SAME commit and say so in its message — or (b) added a
// behavioural branch on a workshop/stage name — stop; that is a
// kernel-genericity decision (ADR-082, CONVEYOR §3); escalate it instead of
// widening the registers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { WORKSHOP_PAYLOAD_CONTRACTS, WORKSHOP_EXECUTABLE_CAPABILITIES, buildWorkshopCapabilityManifest } from '../../dist/process-modules/application/workshop-capability-manifest.js';
import { PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA } from '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * Source with comments blanked but line numbers PRESERVED (block comments are
 * replaced by spaces, line comments emptied). Same intent as the readCode
 * helper in conveyor-completeness-ratchets.test.mjs — a ratchet must judge
 * code, not prose about it — but keeping line numbers so failure output can
 * point at the offending line.
 */
const readCodeLines = (absPath) => readFileSync(absPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
  .split(/\r?\n/);

/** All .ts files under src/ (recursive), minus the module-owned trees the
 * brief and the audit scope out: src/modules/ (installation TS of the four
 * workshops) and src/process-modules/modules/ (their declarative packages). */
function listKernelTypeScriptFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (statSync(abs).isDirectory()) {
        if (rel === 'src/modules' || rel === 'src/process-modules/modules') continue;
        walk(abs);
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push({ abs, rel });
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return out;
}

/** All .ts files under src/ with NO exclusions — used by the cross-kernel
 * copy-count assertions that deliberately include module-owned trees. */
function listAllTypeScriptFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push({ abs, rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/') });
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return out;
}

// ---------------------------------------------------------------------------
// The four frozen admission surfaces (ADR-082 §4).
// ---------------------------------------------------------------------------

const EXPECTED_PAYLOAD_CONTRACT_SCHEMA_IDS = [
  'factory.candidate-verification-evidence-product.v2',
  'factory.development-implementation-result.v1',
  'factory.development-readiness-manifest.v1',
  'factory.development-review-verdict.v1',
  'factory.development-task-graph-proposal.v1',
  'factory.formalization-reconciliation-report.v1',
  'factory.review-verdict.v1',
  'factory.source-change-candidate.v1',
];

const EXPECTED_EXECUTABLE_CAPABILITIES = [
  'check-provider/development.implementation-claim-monotonicity.v1',
  'check-provider/development.implementation-scope.v1',
  'check-provider/development.readiness-profile-monotonicity.v1',
  'check-provider/development.replan-graph.v1',
  'check-provider/development.task-graph-contract.v1',
  'check-provider/development.verification-product-contract.v2',
  'check-provider/discovery.proposal-contract.v1',
  'check-provider/discovery.readiness-contract.v1',
  'check-provider/factory.accessible-counter-sandbox-check.v1',
  'check-provider/factory.authorized-verification-observer.v1',
  'check-provider/factory.local-runnability.v1',
  'check-provider/factory.product-contract.v1',
  'check-provider/factory.review-verdict.v1',
  'check-provider/factory.submission-validator.formalization.acceptance-contract.v1',
  'check-provider/factory.submission-validator.formalization.product-contract.v1',
  'check-provider/factory.submission-validator.formalization.reconciliation.v1',
  'check-provider/factory.submission-validator.formalization.srs-contract.v1',
  'check-provider/factory.submission-validator.formalization.use-cases.v1',
  'post-acceptance-effect/formalization.accept-exact-products.v1',
  'post-acceptance-effect/git-integration',
  'post-acceptance-effect/replay-capture',
  'transition-handler/close-presentation',
  'transition-handler/record-final-acceptance',
  'transition-handler/run-effects',
  'transition-handler/run-gate',
  'transition-handler/route-lifecycle',
];

const COMPOSITION_ROOT = 'src/app/product-lifecycle-runtime.ts';
const REGISTER_FAMILY = /(?:registerDiscovery|registerFormalization|registerDevelopment|registerDelivery)\s*\(/g;

test('surface 1 — WORKSHOP_PAYLOAD_CONTRACTS is exactly the frozen 8 contracts', () => {
  assert.equal(WORKSHOP_PAYLOAD_CONTRACTS.length, 8,
    'payload-contract admission changed: update this frozen count in the SAME commit as the admission (ADR-082 §4)');
  const actual = WORKSHOP_PAYLOAD_CONTRACTS.map((c) => c.schemaId).sort();
  assert.deepEqual(actual, [...EXPECTED_PAYLOAD_CONTRACT_SCHEMA_IDS].sort(),
    'payload-contract set changed: adding/removing a contract is an admission act (ADR-082 §4.1)');
  assert.equal(buildWorkshopCapabilityManifest().payloadContractCount, 8,
    'derived manifest count disagrees with the raw contract array');
});

test('surface 2 — WORKSHOP_EXECUTABLE_CAPABILITIES is exactly the frozen 26 entries, fail-closed at the boundary', () => {
  assert.equal(WORKSHOP_EXECUTABLE_CAPABILITIES.length, 26,
    'executable-capability admission changed: update this frozen count in the SAME commit as the admission (ADR-082 §4)');
  const actual = WORKSHOP_EXECUTABLE_CAPABILITIES
    .map((c) => `${c.kind}/${c.logicalId}`).sort();
  assert.deepEqual(actual, [...EXPECTED_EXECUTABLE_CAPABILITIES].sort(),
    'executable-capability set changed: admitting a provider/effect/handler is an admission act (ADR-082 §4.1)');
  assert.equal(buildWorkshopCapabilityManifest().executableCapabilityCount, 26,
    'derived manifest count disagrees with the raw capability array');

  // The fail-closed boundary being pinned: an undeclared capability cannot be
  // registered — requireExecutableCapability throws WORKSHOP_CAPABILITY_UNDECLARED.
  const manifestSource = readCodeLines(path.join(REPO_ROOT,
    'src/process-modules/application/workshop-capability-manifest.ts')).join('\n');
  assert.match(manifestSource, /function requireExecutableCapability\(/,
    'requireExecutableCapability must remain the admission boundary of the manifest');
  assert.match(manifestSource, /WORKSHOP_CAPABILITY_UNDECLARED/,
    'the fail-closed throw WORKSHOP_CAPABILITY_UNDECLARED must remain in the manifest');
});

test('surface 3 — the composition root registers exactly the four workshops, and nothing else registers them', () => {
  const root = readCodeLines(path.join(REPO_ROOT, COMPOSITION_ROOT)).join('\n');
  for (const name of ['registerDiscovery', 'registerFormalization', 'registerDevelopment', 'registerDelivery']) {
    const calls = [...root.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length;
    assert.equal(calls, 1,
      `${name} must be called exactly once in the composition root — a second call is a new admission point (ADR-082 §4.2)`);
  }

  // Registration call text may appear ONLY in the composition root (the calls)
  // and the four module index.ts files (the definitions). A register* call
  // anywhere else is an admission point outside the composition root.
  const definitionFiles = new Set([
    COMPOSITION_ROOT,
    'src/modules/discovery/index.ts',
    'src/modules/formalization/index.ts',
    'src/modules/development/index.ts',
    'src/modules/delivery/index.ts',
  ]);
  const offenders = [];
  for (const { abs, rel } of listAllTypeScriptFiles()) {
    if (definitionFiles.has(rel)) continue;
    if (REGISTER_FAMILY.test(readCodeLines(abs).join('\n'))) offenders.push(rel);
    REGISTER_FAMILY.lastIndex = 0;
  }
  assert.deepEqual(offenders, [],
    'register* call text outside the composition root and the four module definitions — an admission point moved out of the frozen surface');
});

test('surface 4 — the lifecycle start gateway admits exactly one input schema', () => {
  assert.equal(PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA, 'factory.product-delivery-lifecycle-input.v2',
    'the single accepted lifecycle input schema id changed — ADR-082 §4.4 / C12 own this');
  const root = readCodeLines(path.join(REPO_ROOT, COMPOSITION_ROOT)).join('\n');
  assert.match(root, /schema !== PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA/,
    'the start-gateway equality check must remain in the composition root');
  assert.match(root, /PRODUCT_LIFECYCLE_INPUT_SCHEMA_MISMATCH/,
    'the gateway must keep failing closed with PRODUCT_LIFECYCLE_INPUT_SCHEMA_MISMATCH');

  // No source file may start a lifecycle with an ad-hoc schema string literal:
  // every lifecycleInputSchema assignment must flow through a constant.
  const offenders = [];
  for (const { abs, rel } of listAllTypeScriptFiles()) {
    readCodeLines(abs).forEach((line, i) => {
      if (/lifecycleInputSchema\s*:\s*['"`]/.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'lifecycleInputSchema assigned from a string literal — only the frozen constant may be admitted (ADR-082 §4.3)');
});

// ---------------------------------------------------------------------------
// The single behavioural leak (ADR-082 §4, last paragraph; owned by K15/C5).
// ---------------------------------------------------------------------------

test('the linkType behavioural ternary exists in exactly the three known copies', () => {
  const copies = [];
  for (const { abs, rel } of listAllTypeScriptFiles()) {
    readCodeLines(abs).forEach((line, i) => {
      if (/=== ?'development' ?\? ?'implements' ?: ?'depends_on'/.test(line)) {
        copies.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(copies.sort(), [
    // 548 -> 567 -> 575 -> 576: the projection-persistence copy shifted when
    // the finding-trajectory budget landed above it (19e6002b lineage), again
    // when the reviewer-round-history reader landed above it (blindsight C6),
    // and once more when the SEAM L2 recovery-feedback reader landed above it
    // (blindsight integration-verify) — same three copies, refreshed anchor.
    'src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts:576',
    'src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts:413',
    'src/tools/tasks.ts:552',
  ], `the linkType stage-name ternary was copied or moved (${copies.join(', ')}); ` +
    'the kernel copy is the audit-blessed single behavioural leak (K15/C5 own it) — a fourth copy is new behavioural branching');
});

// ---------------------------------------------------------------------------
// General behavioural scan: no workshop/stage-name branch outside the
// registers. Three registers with three different meanings:
//   BENIGN_NAME_DATA      — the audit §6 classified the mention as data
//                           (warning sets, owner metadata, named constants…).
//   BLESSED_BEHAVIOURAL   — the audit §6 blessed the site as THE single
//                           behavioural branch (the projection-persistence
//                           linkType block). Do not fix; K15/C5 own it.
//   DRIFT_REPORTED        — behavioural sites the audit MISSED (they predate
//                           it). Escalated to the architect with the stage-4
//                           report; pending adjudication. NOT silently
//                           allowlisted: moving an entry out of this register
//                           requires an architectural decision.
// Adding any entry to any register is a deliberate act — say it in the commit.
// ---------------------------------------------------------------------------

const NAMES = String.raw`(?:discovery|formalization|development|delivery|initial-discovery|solution-formalization|solution-development|delivery-release|factory\.discovery)`;

const PREDICATES = [
  ['P1:name-equality',
    new RegExp(String.raw`(?:===|!==)\s*'${NAMES}'|'${NAMES}'\s*(?:===|!==)`)],
  ['P2:name-array-includes',
    new RegExp(String.raw`\[[^\]]*'${NAMES}'[^\]]*\]\s*\.\s*(?:includes|indexOf)\s*\(`)],
  ['P2b:name-array-declaration',
    new RegExp(String.raw`(?:const|let)\s+\w+[^=\n]*=\s*\[[^\]]*'${NAMES}'`)],
  ['E:bare-name-element',
    new RegExp(String.raw`^\s*'${NAMES}'\s*,?\s*$`)],
  ['P3:sql-stage-filter',
    new RegExp(String.raw`(?:stage_id|workflow_stage|module_ref_key|module_ref)\s*=\s*'${NAMES}'`)],
  ['P4a:constant-member-identity',
    new RegExp(String.raw`[A-Z][A-Z0-9_]{3,}\.(?:name|kind|version|id)\b[^;\n]{0,120}(?:===|!==)|(?:===|!==)[^;\n]{0,120}[A-Z][A-Z0-9_]{3,}\.(?:name|kind|version|id)\b`)],
  ['P4b:refs-set-gate',
    new RegExp(String.raw`[A-Z][A-Z0-9_]{3,}_REFS?\s*\.\s*has\s*\(`)],
];

const BENIGN_NAME_DATA = [
  { file: 'src/process-modules/application/validate-process-module.ts', anchor: "'discovery',", why: 'STANDARD_MODULE_KINDS warning set — audit §6: legitimate soft set' },
  { file: 'src/process-modules/application/validate-process-module.ts', anchor: "'formalization',", why: 'STANDARD_MODULE_KINDS warning set — audit §6: legitimate soft set' },
  { file: 'src/process-modules/application/validate-process-module.ts', anchor: "'development',", why: 'STANDARD_MODULE_KINDS warning set — audit §6: legitimate soft set' },
  { file: 'src/process-modules/application/validate-process-module.ts', anchor: "'delivery',", why: 'STANDARD_MODULE_KINDS warning set — audit §6: legitimate soft set' },
];

const BLESSED_BEHAVIOURAL = [
  { file: 'src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts', anchor: "['development', 'verification'].includes(input.workflowStage", why: 'AC-provenance gate at the audit-blessed site' },
  { file: 'src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts', anchor: "workflowStage === 'development' ? 'implements'", why: 'THE single behavioural branch (linkType) — audit §6; K15/C5 own it; report, never fix' },
];

const DRIFT_REPORTED = [
  { file: 'src/tools/tasks.ts', anchor: "const provenanceRequired = ['development', 'verification', 'integration']", why: 'task_create provenance gate — audit miss' },
  { file: 'src/tools/tasks.ts', anchor: "['development', 'verification'].includes(workflowStage", why: 'task_create AC-type gate — audit miss; tool-layer sibling of the blessed projection gate' },
  { file: 'src/tools/tasks.ts', anchor: "const order = ['discovery','formalization','planning'", why: 'stage-ordering gate — audit miss' },
  { file: 'src/tools/tasks.ts', anchor: "const traceType = workflowStage === 'development'", why: 'linkType ternary copy in the tool layer — audit miss' },
  { file: 'src/app/factory-continuation.ts', anchor: "stage_id='solution-development'", why: 'SQL boundary lookup scoped to the development stage — audit miss' },
  { file: 'src/app/factory-continuation.ts', anchor: "current_stage_id === 'solution-development'", why: 'continuation terminal-boundary equality on a stage id — audit miss' },
  { file: 'src/app/factory-release-continuation.ts', anchor: "stage_id='delivery-release'", why: 'SQL boundary lookup scoped to the delivery stage — audit miss' },
  { file: 'src/process-modules/lifecycles/product-build-lifecycle.ts', anchor: "stage.id !== 'delivery-release'", why: 'lifecycle derivation filters a stage by id — audit miss (lifecycle-is-data §2.4 may reclassify as benign)' },
  { file: 'src/process-modules/lifecycles/product-build-lifecycle.ts', anchor: "stage.id !== 'solution-development'", why: 'lifecycle derivation rewrites the development stage routes — audit miss (same)' },
  // The settlement-debug entry ("module_ref_key === 'discovery'") LEFT this
  // register by architectural adjudication: ADR-095 Decision 1 (Phase 3.2,
  // 2026-08-24) removed the legacy Discovery query block, deleting exactly
  // that one behavioural site — drift 16→15 in the same commit.
  { file: 'src/app/product-lifecycle-repository-bindings.ts', anchor: 'moduleRef.name !== DEVELOPMENT_PROCESS_MODULE_REF.name', why: 'repository binding gated on the development module-ref constant — audit miss' },
  { file: 'src/app/product-lifecycle-repository-bindings.ts', anchor: 'moduleRef.version !== DEVELOPMENT_PROCESS_MODULE_REF.version', why: 'repository binding gated on the development module-ref version — audit miss' },
  { file: 'src/infrastructure/replay/replay-authority-rebinder.ts', anchor: 'DEVELOPMENT_MODULE_REFS.has(String(', why: 'replay rebinding gated on the development module-ref set — audit miss; kernel by ADR-082\'s own definition (replay)' },
  { file: 'src/infrastructure/workplace/sqlite-author-candidate-carry-forward.ts', anchor: "stage_id='solution-development'", why: 'carry-forward lookup scoped to the development stage — audit miss' },
];

// drift 16→15 at Phase 3.2 (ADR-095): the settlement-debug behavioural site
// was deleted with the legacy Discovery query — see the note in DRIFT_REPORTED.
const FROZEN_REGISTER_COUNTS = { benign: 4, blessed: 2, drift: 13 };

test('the kernel branches on a workshop/stage name only inside the frozen registers', () => {
  const registers = [
    ...BENIGN_NAME_DATA.map((e) => ({ ...e, register: 'BENIGN_NAME_DATA' })),
    ...BLESSED_BEHAVIOURAL.map((e) => ({ ...e, register: 'BLESSED_BEHAVIOURAL' })),
    ...DRIFT_REPORTED.map((e) => ({ ...e, register: 'DRIFT_REPORTED' })),
  ];
  const claims = new Map(registers.map((e) => [e, 0]));

  const unclaimed = [];
  for (const { abs, rel } of listKernelTypeScriptFiles()) {
    readCodeLines(abs).forEach((line, i) => {
      if (!PREDICATES.some(([, re]) => re.test(line))) return;
      const entry = registers.find((e) => e.file === rel && line.includes(e.anchor));
      if (!entry) {
        unclaimed.push(`  ${rel}:${i + 1}: ${line.trim()}`);
        return;
      }
      claims.set(entry, claims.get(entry) + 1);
    });
  }

  assert.deepEqual(unclaimed, [],
    `new workshop/stage-name branch(es) outside the registers (kernel-genericity, ADR-082 / CONVEYOR §3 — escalate, do not widen):\n${unclaimed.join('\n')}`);

  const stale = registers.filter((e) => claims.get(e) === 0)
    .map((e) => `  [${e.register}] ${e.file} :: ${e.anchor}`);
  assert.deepEqual(stale, [],
    `register entries that no longer claim any line (stale — remove or re-anchor them):\n${stale.join('\n')}`);

  const overclaimed = registers.filter((e) => claims.get(e) > 1)
    .map((e) => `  [${e.register}] ${e.file} :: ${e.anchor} claimed ${claims.get(e)} lines`);
  assert.deepEqual(overclaimed, [],
    `register anchors must be unique per file — one anchor claimed several hit lines:\n${overclaimed.join('\n')}`);

  assert.equal(BENIGN_NAME_DATA.length, FROZEN_REGISTER_COUNTS.benign);
  assert.equal(BLESSED_BEHAVIOURAL.length, FROZEN_REGISTER_COUNTS.blessed);
  assert.equal(DRIFT_REPORTED.length, FROZEN_REGISTER_COUNTS.drift,
    'the DRIFT_REPORTED register changed: entries leave only by architectural adjudication (see header)');

  console.log('[kernel-admission-distance] '
    + `contracts=${WORKSHOP_PAYLOAD_CONTRACTS.length} `
    + `capabilities=${WORKSHOP_EXECUTABLE_CAPABILITIES.length} `
    + 'registerCalls=4 inputSchemas=1 '
    + `behavioural: blessed=${BLESSED_BEHAVIOURAL.length} `
    + `benign=${BENIGN_NAME_DATA.length} `
    + `driftReported=${DRIFT_REPORTED.length} `
    + 'linkTypeCopies=3');
});
