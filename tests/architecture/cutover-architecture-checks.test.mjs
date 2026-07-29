// tests/architecture/cutover-architecture-checks.test.mjs
//
// W11-A8 — Product Scenario Cutover architecture checks (plan section 0.14.9,
// 14.14.6; WAVE11-CUTOVER-SPEC.md §4 exit gate 5). Tightened architecture
// checks focused on the cutover boundary itself:
//
//   1. NEW-CORE IMPORTS CLEAN. The scenario-based execution path (the "new
//      core" that Wave 11 cuts new runs over to) must NEVER import a module
//      implementation, the built-in module catalog, the built-in installation
//      registry, the manual product composition root, or the global db/schema
//      singletons. A new-core file that reaches back into any of those IS a
//      hidden fallback (plan §3.13, §14.14.3, C057): the cutover would be
//      silently routing new runs through the legacy path instead of installed
//      scenarios. This is the invariant the spec §4.5 exit gate asserts:
//      "Architecture checks show no hidden fallbacks in new-core."
//
//   2. COMPATIBILITY-USAGE REPORTING. Every importer of a legacy compatibility
//      entry point is enumerated and the count is surfaced on every green run
//      (plan §14.14.4: "Record every compatibility-path use and define the
//      retention condition required before its removal"). The current importers
//      form the Wave 13 removal target. The ratchet fails if a NEW-CORE file
//      appears among the compatibility importers (overlap with rule 1) and
//      fails if a known importer disappears without the entry being removed
//      from the baseline — so the shrinkage toward Wave 13 is always visible
//      and the ratchet only ever tightens.
//
// This test complements dependency-direction.test.mjs (the repo-wide five-rule
// ratchet). That test governs the full dependency graph; THIS test zooms in on
// the cutover boundary: it defines what "new core" means for the cutover and
// proves the cutover did not introduce a hidden path from the new execution
// lane back into the legacy composition.
//
// The test PASSES today (Wave 10 checkpoint: the new scenario core already
// exists alongside the legacy path and imports nothing forbidden). It ratchets
// forward: when Wave 11 lands composition-loader / command-adapters / the
// feature-detected composition switch, the new-core glob set below already
// covers those files, so any hidden fallback they introduce fails this test.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanDependencyGraph } from '../../tools/dep-graph-scanner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const GRAPH = scanDependencyGraph({ rootDir: REPO_ROOT });

// ---------------------------------------------------------------------------
// Cutover boundary: what is "new core" vs "compatibility" vs "forbidden".
//
// All paths are repo-relative POSIX paths, as produced by the scanner.
// ---------------------------------------------------------------------------

// NEW CORE — the scenario-based execution path Wave 11 cuts new runs over to.
//
// This set is intentionally defined by STABLE glob predicates (not a hard-coded
// file list) so it auto-expands as the remaining Wave 11 lanes land:
//   - W11-A1 product-delivery-scenario-package.ts
//   - W11-A2 application/composition-loader.ts
//   - W11-A3 application/command-adapters.ts
//   - W11-A4 orchestrate-cli-scenario-adapter.ts + tools/process-modules-scenario-adapter.ts
//   - W11-A5 application/legacy-run-inventory.ts
// Every file matched by these predicates is held to rule 1 (clean imports).
const NEW_CORE = [
  // Generic scenario execution services (W7-A2..A6).
  /^src\/process-modules\/application\/scenario-runner\.ts$/,
  /^src\/process-modules\/application\/scenario-router\.ts$/,
  /^src\/process-modules\/application\/scenario-module-lock\.ts$/,
  /^src\/process-modules\/application\/scenario-stage-output\.ts$/,
  // The scenario manifest contract (domain SPI) the new core consumes.
  /^src\/process-modules\/domain\/spi\/scenario-manifest\.ts$/,
  // The package + scenario installation infrastructure (W2/W7).
  /^src\/process-modules\/installation\//,
  // W11-A2 generic composition loader (loads installed packages+scenarios at
  // startup instead of the hard-coded catalog/installations). New runs route
  // through here once the serial cutover commit lands.
  /^src\/process-modules\/application\/composition-loader\.ts$/,
  // W11-A3 generic application command + result adapters.
  /^src\/process-modules\/application\/command-adapters\.ts$/,
  // W11-A1 installed Product Delivery scenario package.
  /^src\/process-modules\/installation\/product-delivery-scenario-package\.ts$/,
  /^src\/installation\/product-delivery-scenario-package\.ts$/,
  // W11-A4 CLI / scenario-selection adapters (the new-run selection path).
  /orchestrate-cli-scenario-adapter\.ts$/,
  /^src\/tools\/process-modules-scenario-adapter\.ts$/,
  // W11-A5 legacy-run inventory (records compatibility-path use; lives in the
  // new core because it is the audit surface for the cutover).
  /^src\/process-modules\/application\/legacy-run-inventory\.ts$/,
];

function isNewCore(p) {
  return NEW_CORE.some((re) => re.test(p));
}

// FORBIDDEN imports for new-core files. Importing any of these is a hidden
// fallback: the new execution lane silently reaching back into the legacy
// composition / built-in catalog / module implementations / global singletons.
//
//   - modules/        : any module implementation, plus the built-in catalog
//                       (modules/catalog.ts) and built-in installation registry
//                       (modules/installations.ts). Catalog/installations
//                       import IS module-name switching in disguise (plan §3.6).
//   - composition/    : the manual product-lifecycle-runtime composition root
//                       that hard-wires concrete modules + sqlite repos. This is
//                       the legacy path the cutover replaces (plan §3.13,
//                       §14.14.2; Rule 6 in dependency-direction.test.mjs).
//   - db.ts/schema.ts : the global SQLite singletons. New core must consume
//                       ports, never global state (plan §3.16).
const FORBIDDEN_FOR_NEW_CORE = [
  /^src\/process-modules\/modules\//,
  /^src\/process-modules\/composition\//,
  /^src\/db\.ts$/,
  /^src\/schema\.ts$/,
];

function isForbiddenForNewCore(t) {
  return FORBIDDEN_FOR_NEW_CORE.some((re) => re.test(t));
}

// COMPATIBILITY entry points — the legacy surface that Wave 13 removes once the
// retention policy proves no supported run needs it (WAVE11-CUTOVER-SPEC.md §4
// gate 4; plan §14.14.3/§14.16). New runs must NOT import these; only explicit
// compatibility adapters and the legacy composition root may.
//
//   - modules/catalog.ts            : createBuiltInProcessModuleRegistry
//   - modules/installations.ts      : createBuiltInProcessModuleInstallationRegistry
//   - application/legacy-scenario-adapter.ts : the W7-A8 adapter that bridges
//                                     pinned legacy runs to the scenario shape
const COMPATIBILITY_ENTRY_POINTS = [
  'src/process-modules/modules/catalog.ts',
  'src/process-modules/modules/installations.ts',
  'src/process-modules/application/legacy-scenario-adapter.ts',
];

function isCompatibilityEntryPoint(p) {
  return COMPATIBILITY_ENTRY_POINTS.includes(p);
}

// ---------------------------------------------------------------------------
// Rule 1: new-core imports clean — no hidden fallbacks.
// ---------------------------------------------------------------------------

function hiddenFallbackViolations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    if (!isNewCore(src)) continue;
    for (const t of targets) {
      if (isForbiddenForNewCore(t)) {
        out.push({ source: src, target: t });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2: compatibility-usage reporting.
//
// Enumerate every importer of a compatibility entry point. These importers are
// the Wave 13 removal target. A NEW-CORE file appearing here is a hidden
// fallback (already caught by rule 1, but reported distinctly here so the
// cutover-specific failure is obvious). The baseline importer set is frozen so
// shrinkage (Wave 13 removing an importer) is visible and accidental re-growth
// outside the baseline is caught.
// ---------------------------------------------------------------------------

function compatibilityUsage(graph) {
  const usage = []; // { entry, importer }
  for (const [src, targets] of Object.entries(graph)) {
    for (const t of targets) {
      if (isCompatibilityEntryPoint(t)) {
        usage.push({ entry: t, importer: src });
      }
    }
  }
  usage.sort((a, b) =>
    a.entry === b.entry
      ? a.importer.localeCompare(b.importer)
      : a.entry.localeCompare(b.entry),
  );
  return usage;
}

// Baseline of compatibility-path importers as of the Wave 10 checkpoint. These
// are the legacy composition root, the legacy CLI tool surface, and the legacy
// execution-profile resolver — exactly the surfaces Wave 13 removes. Each entry
// is `{ entry, importer }`. The ratchet fails if:
//   - an importer appears that is NOT in this baseline (unallowlisted growth);
//   - a baseline importer disappears (stale entry — tighten by removing it so
//     the shrinkage is recorded and the ratchet only ever tightens).
//
// A NEW-CORE importer can NEVER be allowlisted here: a new-core file importing
// a compatibility entry point is a hidden fallback regardless of who added it.
const COMPATIBILITY_BASELINE = [
  // createBuiltInProcessModuleRegistry importers.
  { entry: 'src/process-modules/modules/catalog.ts', importer: 'src/app/composition-root.ts' },
  { entry: 'src/process-modules/modules/catalog.ts', importer: 'src/process-modules/application/execution-profile-resolver.ts' },
  { entry: 'src/process-modules/modules/catalog.ts', importer: 'src/process-modules/composition/product-lifecycle-runtime.ts' },
  { entry: 'src/process-modules/modules/catalog.ts', importer: 'src/tools/process-modules.ts' },
  // createBuiltInProcessModuleInstallationRegistry importers.
  { entry: 'src/process-modules/modules/installations.ts', importer: 'src/app/composition-root.ts' },
  { entry: 'src/process-modules/modules/installations.ts', importer: 'src/process-modules/composition/product-lifecycle-runtime.ts' },
  // legacy-scenario-adapter has NO importers today (it is consumed via the
  // scenario-tests and is the bridge legacy pinned runs will replay through
  // once the cutover wires it). No baseline entry => any importer added is
  // either a legitimate explicit compatibility adapter (allowlist it here with
  // a Wave 13 reason) or a hidden fallback (rule 1 already blocks it).
];

function compatKey(u) {
  return `${u.importer} -> ${u.entry}`;
}

function diffCompatibilityUsage(actual) {
  const baseline = new Set(COMPATIBILITY_BASELINE.map(compatKey));
  const actualSet = new Set(actual.map(compatKey));

  const unallowlisted = actual.filter((u) => !baseline.has(compatKey(u)));
  const stale = COMPATIBILITY_BASELINE.filter((u) => !actualSet.has(compatKey(u)));
  return { unallowlisted, stale };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

const HIDDEN_FALLBACKS = hiddenFallbackViolations(GRAPH);
const COMPAT_USAGE = compatibilityUsage(GRAPH);
const { unallowlisted: compatUnallowlisted, stale: compatStale } =
  diffCompatibilityUsage(COMPAT_USAGE);

test('cutover ratchet: scanner sees the new-core execution path', () => {
  // Guard against the glob set silently matching nothing (e.g. after a rename).
  // The scenario execution services are the heart of the new core; if they
  // disappear from the graph the ratchet is no longer enforcing anything.
  const newCoreFiles = Object.keys(GRAPH).filter(isNewCore).sort();
  const mustExist = [
    'src/process-modules/application/scenario-runner.ts',
    'src/process-modules/application/scenario-router.ts',
    'src/process-modules/application/scenario-module-lock.ts',
    'src/process-modules/application/scenario-stage-output.ts',
    'src/process-modules/domain/spi/scenario-manifest.ts',
  ];
  const missing = mustExist.filter((f) => !newCoreFiles.includes(f));
  assert.deepEqual(
    missing,
    [],
    `new-core glob set no longer matches the scenario execution services. ` +
      `Missing: ${missing.join(', ')}. Update the NEW_CORE predicates.`,
  );
  assert.ok(
    newCoreFiles.length >= 6,
    `expected >=6 new-core files, got ${newCoreFiles.length}`,
  );
});

test('cutover ratchet: new-core imports clean — no hidden fallbacks', () => {
  // WAVE11-CUTOVER-SPEC.md §4 gate 5: "Architecture checks show no hidden
  // fallbacks in new-core." A new-core file importing a module implementation,
  // the built-in catalog/installations, the manual composition root, or the
  // global db/schema singletons IS a hidden fallback: the cutover would be
  // silently routing new runs through the legacy path instead of installed
  // scenarios (plan §14.14.3, §3.13, C057).
  if (HIDDEN_FALLBACKS.length > 0) {
    const lines = HIDDEN_FALLBACKS.map(
      (v) => `  ${v.source} -> ${v.target}`,
    );
    assert.fail(
      `${HIDDEN_FALLBACKS.length} hidden-fallback import(s) in the new-core ` +
        `execution path. A new-core file must not import a module implementation, ` +
        `the built-in catalog/installations, the manual composition root, or the ` +
        `global db/schema singletons — that is the legacy path the cutover replaces:\n` +
        lines.join('\n'),
    );
  }
});

test('cutover ratchet: compatibility entry points have no unallowlisted importers', () => {
  // Every importer of a compatibility entry point must be in the frozen
  // baseline. A new importer is either a legitimate explicit compatibility
  // adapter (add it to COMPATIBILITY_BASELINE with a Wave 13 reason) or, if it
  // is a new-core file, a hidden fallback (rule 1 already blocks it, but this
  // surfaces it on the cutover boundary).
  if (compatUnallowlisted.length > 0) {
    const lines = compatUnallowlisted.map(
      (u) => `  ${u.importer} -> ${u.entry}`,
    );
    assert.fail(
      `${compatUnallowlisted.length} new compatibility-path importer(s) not in ` +
        `COMPATIBILITY_BASELINE. If it is an explicit compatibility adapter, add it ` +
        `to the baseline with a Wave 13 removal reason; if it is a new-core file, ` +
        `it is a hidden fallback (fix the import):\n${lines.join('\n')}`,
    );
  }
});

test('cutover ratchet: zero stale compatibility baseline entries', () => {
  // Stale detection: an importer that left the baseline without its entry being
  // removed would let the ratchet silently loosen. Removing an importer is
  // progress toward Wave 13 — record it by deleting the baseline entry.
  if (compatStale.length > 0) {
    const lines = compatStale.map(
      (u) => `  ${u.importer} -> ${u.entry}`,
    );
    assert.fail(
      `${compatStale.length} COMPATIBILITY_BASELINE entry/entries are stale — the ` +
        `importer is already gone. Remove them from the baseline to tighten the ` +
        `ratchet (this records the shrinkage toward Wave 13 removal):\n` +
        lines.join('\n'),
    );
  }
});

test('cutover ratchet: no new-core file imports a compatibility entry point', () => {
  // Belt-and-suspenders for rule 1: even though rule 1 already forbids new-core
  // imports of modules/*, assert explicitly that no new-core file imports a
  // COMPATIBILITY entry point. This makes the cutover-specific failure obvious
  // and keeps it visible if the forbidden set is ever narrowed.
  const newCoreCompat = COMPAT_USAGE.filter((u) => isNewCore(u.importer));
  if (newCoreCompat.length > 0) {
    const lines = newCoreCompat.map(
      (u) => `  ${u.importer} -> ${u.entry}`,
    );
    assert.fail(
      `${newCoreCompat.length} new-core file(s) import a compatibility entry ` +
        `point — the cutover must route new runs through installed scenarios, not ` +
        `the legacy compatibility surface:\n${lines.join('\n')}`,
    );
  }
});

test('cutover ratchet: reports compatibility-usage count for shrinkage visibility', () => {
  // Plan §14.14.4 / §14.16.1: record every compatibility-path use and define
  // the retention condition required before removal. This test surfaces the
  // current usage count on every green run so the Wave 13 removal target is
  // always visible and shrinkage is observable over time.
  const byEntry = {};
  for (const u of COMPAT_USAGE) {
    byEntry[u.entry] = (byEntry[u.entry] || 0) + 1;
  }
  const summary = Object.entries(byEntry)
    .map(([e, c]) => `${e}=${c}`)
    .join(', ');
  // eslint-disable-next-line no-console
  console.log(
    `\n  COMPATIBILITY-USAGE: ${COMPAT_USAGE.length} importer/entry edges ` +
      `(${summary || 'none'}). Baseline: ${COMPATIBILITY_BASELINE.length} ` +
      `frozen edges. Wave 13 removes these once the retention policy proves ` +
      `no supported run needs them; the ratchet fails if usage grows beyond ` +
      `the baseline.`,
  );
  assert.ok(
    COMPATIBILITY_BASELINE.length > 0,
    'compatibility baseline must be seeded with the Wave 10 importers',
  );
});
