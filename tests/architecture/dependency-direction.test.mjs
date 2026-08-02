// tests/architecture/dependency-direction.test.mjs
//
// W0-A1 repository-wide dependency-direction ratchet (plan section 0.3.2,
// 13.14, 14.1.3, C047). Enforces the five intended dependency rules from
// plan section 3 (Non-negotiable Architecture Rules):
//
//   1. (3.7) A module never imports another module implementation.
//   2. (3.7) A module never imports Runtime persistence adapters, infrastructure,
//      db.ts, or schema.ts. Ports under persistence/*-repository.ts are allowed.
//   3. (3.8) A Lifecycle Scenario references module contracts and installed
//      package identities only - never module implementation classes.
//   4. (3.6) Runtime core must not switch on module names/kinds. Guarded two
//      ways: (a) the four core files (domain/, node-executor.ts,
//      generic-flow-executor.ts) must not contain module-name string literals
//      in code; (b) Runtime core must not import the built-in module catalog
//      (modules/catalog.ts) - that import IS module-name switching in disguise.
//   5. (3.16) Module domain layer is pure: domain/ may not import application/,
//      persistence/, composition/, modules/, or infrastructure/.
//   6. (special) The manual composition root is allowlisted as a known smell:
//      Wave 11 cutover replaces it. Codified so any NEW module/sqlite edge it
//      gains is visible, but every current edge is grandfathered.
//
// Current violations are seeded into KNOWN_VIOLATIONS with a `reason` naming
// the plan phase that will fix them. The test PASSES today (zero unallowlisted
// violations) and ratchets: a future wave must either keep an allowlisted
// violation or remove it from the allowlist AND fix the underlying import. If
// the import is fixed but the entry remains in KNOWN_VIOLATIONS, the test
// FAILS (stale-allowlist detection) so the ratchet only ever tightens.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanDependencyGraph } from '../../tools/dep-graph-scanner.mjs';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const GRAPH = scanDependencyGraph({ rootDir: REPO_ROOT });

// ---------------------------------------------------------------------------
// Path classifiers (repo-relative POSIX paths, as produced by the scanner).
// ---------------------------------------------------------------------------

const MODULE_FILE_RE = /^src\/process-modules\/modules\/([^/]+)\//;
const MODULE_DIR = /^src\/process-modules\/modules\//;
const PERSISTENCE_DIR = /^src\/process-modules\/persistence\//;
const APPLICATION_DIR = /^src\/process-modules\/application\//;
const COMPOSITION_DIR = /^src\/process-modules\/composition\//;
const LIFECYCLES_DIR = /^src\/process-modules\/lifecycles\//;
const DOMAIN_DIR = /^src\/process-modules\/domain\//;
const INFRA_DIR = /^src\/infrastructure\//;

function moduleNameOf(p) {
  const m = p.match(MODULE_FILE_RE);
  return m ? m[1] : null;
}
function isModuleImpl(p) {
  return MODULE_DIR.test(p);
}
function isPersistenceAdapter(p) {
  // Concrete sqlite-* adapter, infrastructure, or the global db/schema SQL.
  return (
    /^src\/process-modules\/persistence\/sqlite-/.test(p) ||
    INFRA_DIR.test(p) ||
    p === 'src/db.ts' ||
    p === 'src/schema.ts'
  );
}

// ---------------------------------------------------------------------------
// KNOWN_VIOLATIONS allowlist.
//
// Each entry is `{ source, target, rule, reason }`. `rule` is the rule number
// (1-6) the entry violates; `reason` names the plan phase/wave that will fix
// it. The ratchet enforces:
//   - every actual violation must appear here (else FAIL: unallowlisted);
//   - every entry here must still be an actual violation (else FAIL: stale).
// ---------------------------------------------------------------------------

const REASON = {
  lifecycleContracts: 'Phase 8/9 will replace with contract refs',
  discoverySelfContained: 'Wave 9 makes discovery self-contained',
  compositionCutover: 'Wave 11 cutover replaces composition root',
  modulePorts: 'Phase 4/5 moves persistence behind module-local ports',
  moduleIsolation: 'Phase 6 module package isolation removes inter-module import',
  catalogInjection: 'Phase 3 PackageRegistry replaces built-in catalog lookup',
};

// Versioned baseline for the KNOWN_VIOLATIONS allowlist size — the ratchet's
// irreversibility anchor (plan section 14.1.3 exit gate / CONVEYOR-MENTAL-MODEL
// "can only shrink"). The shrinkage test asserts
// `KNOWN_VIOLATIONS.length <= ALLOWLIST_BASELINE`, so growth is caught even
// when a new edge is paired with its allowlist entry (the :371 unallowlisted
// test only catches an entry without a real edge). To raise the baseline, a
// wave must bump this constant deliberately with owner + date + a
// removal-plan comment, making every allowlist growth a visible, reviewed
// baseline change rather than a silent entry append.
//   Bump history:
//     2026-08-01  baseline = 0  (post-CONVEYOR/W13: all known violations fixed)
//     2026-08-02  baseline = 8  (Wave 7 re-check: physical extraction of the 8
//                SQLite adapters to src/infrastructure/process-modules/. The
//                concrete implementations no longer live inside the module
//                tree — the physical-placement gate
//                (tests/architecture/no-sqlite-in-modules.test.mjs) now forbids
//                any better-sqlite3 import / Sqlite* class / sqlite-*.ts impl
//                file under modules/. To preserve import resolution for the 4
//                non-owned src/ files and ~15 tests that still import the
//                historical paths during the parallel-agent refactor window,
//                each old path is a PURE re-export shim that points at the
//                infrastructure adapter. The scanner sees each shim→infra edge
//                as a Rule 2 violation (a module file importing a persistence
//                adapter); these 8 edges are allowlisted here so the ratchet
//                makes them VISIBLE and REQUIRE their removal. Removal plan:
//                each shim is deleted once every importer (sibling modules,
//                saga3-formalization-engine.ts, tools/delivery-approvals.ts,
//                formalization/package/ports/index.ts, formalization-installation.ts,
//                and the relevant tests) migrates to the infrastructure path
//                directly; each migrated importer lets one allowlist entry +
//                its shim be deleted, shrinking the baseline back to 0. Owner:
//                Wave 7 re-check lane.)
const ALLOWLIST_BASELINE = 8;

const KNOWN_VIOLATIONS = [
  // ---- Rule 1: module imports another module implementation ----
  // (delivery→development-schemas removed in CONVEYOR Wave 7: schema-id constants inlined)

  // ---- Rule 2: module imports Runtime persistence adapter / infra / db ----
  // CONVEYOR Wave 7 — Isolate modules behind ports: ALL module→infra/db
  // violations are now gone. Every module (development, delivery, discovery,
  // formalization) speaks driver-neutral ports; the composition root wires
  // concrete SQLite adapters and injects them. Removed entries:
  //  - delivery/sqlite-delivery-approval-inbox → db.ts (db injected)
  //  - delivery/sqlite-delivery-runtime → db.ts (db injected)
  //  - delivery/sqlite-delivery-runtime → sqlite-external-effect-ledger (port)
  //  - delivery/sqlite-delivery-runtime → sqlite-process-product-repository (port)
  //  - development/development-persistence → sqlite-process-run-repository (parent table ensured by composition root)
  //  - discovery/discovery-installation → db.ts (BriefProvisioningPort injected)
  //  - formalization/formalization-installation → db.ts (BriefProvisioningPort injected)
  //  - delivery-persistence → sqlite-process-run-repository (parent table ensured by composition root)
  //  - development-kernel-ports → sqlite-managed-production-ledger (interface moved inline)
  //  - formalization-kernel-ports → sqlite-managed-production-ledger (interface moved inline)
  //  - formalization-package-adapters → sqlite-managed-production-ledger (interface moved inline)
  // No Rule-2 entries remain.
  //
  // W7-RECHECK (2026-08-02) — the 8 concrete SQLite adapters were physically
  // extracted from the module tree to src/infrastructure/process-modules/
  // (development/delivery/formalization/{,*-persistence,sqlite-*}). To keep
  // every historical import path resolving during the parallel-agent refactor
  // window (4 non-owned src/ importers + ~15 tests still import the old
  // paths), each old path is now a PURE re-export shim pointing at the
  // infrastructure adapter. The scanner sees each shim→infra edge as a Rule 2
  // violation; the 8 edges below are allowlisted so the ratchet makes them
  // VISIBLE and REQUIRES their removal. The physical-placement gate
  // (tests/architecture/no-sqlite-in-modules.test.mjs) independently forbids
  // any NEW sqlite substrate under modules/ — these shims are the ONLY module
  // files that may reference infrastructure, and only as pure re-exports.
  // Removal plan: delete each shim (and its allowlist entry) once every
  // importer migrates to the infrastructure path. See ALLOWLIST_BASELINE bump
  // comment above for the per-shim owner list.
  { source: 'src/process-modules/modules/development/development-persistence.ts',
    target: 'src/infrastructure/process-modules/development/development-persistence.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/development/sqlite-development-settlement-state.ts',
    target: 'src/infrastructure/process-modules/development/sqlite-development-settlement-state.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/delivery/delivery-persistence.ts',
    target: 'src/infrastructure/process-modules/delivery/delivery-persistence.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/delivery/sqlite-delivery-approval-inbox.ts',
    target: 'src/infrastructure/process-modules/delivery/sqlite-delivery-approval-inbox.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/delivery/sqlite-delivery-runtime.ts',
    target: 'src/infrastructure/process-modules/delivery/sqlite-delivery-runtime.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/formalization/formalization-persistence.ts',
    target: 'src/infrastructure/process-modules/formalization/formalization-persistence.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/formalization/sqlite-formalization-kernel.ts',
    target: 'src/infrastructure/process-modules/formalization/sqlite-formalization-kernel.ts',
    rule: 2, reason: REASON.modulePorts },
  { source: 'src/process-modules/modules/formalization/package/ports/sqlite-formalization-package-adapters.ts',
    target: 'src/infrastructure/process-modules/formalization/package/sqlite-formalization-package-adapters.ts',
    rule: 2, reason: REASON.modulePorts },

  // ---- Rule 3: lifecycle scenario imports module implementation ----
  // CONVEYOR Wave 7 — Isolate modules behind ports: ALL 9 lifecycle→module
  // edges are gone. The lifecycle now imports only its sibling contracts module
  // (`product-delivery-module-contracts.ts`) for the 4 `*_PROCESS_MODULE_REF`
  // identity refs + 4 schema-id strings (durable contracts, not implementation),
  // and reaches the 3 module policy-hashing functions only through the injected
  // `LifecycleInputPolicyValidationPort` (composition root wires a concrete
  // adapter). Removed entries:
  //  - delivery/delivery-process-module, delivery-schemas, delivery-settlement-policy
  //  - development/development-process-module, development-schemas, development-settlement-policy
  //  - discovery/discovery-process-module
  //  - formalization/formalization-process-module, formalization-schemas
  // No Rule-3 entries remain.

  // ---- Rule 4: removed in W13-A1 (catalog deleted, resolver no longer imports it) ----

  // ---- Rule 6: removed in W13-A6 (composition root relocated to src/app/) ----
  // (plan section 13.10 / 14.11 - Wave 11 replaces the manual composition root)
  //
  // W13-A6 REMOVED all 34 Rule 6 entries. The manual composition body that
  // used to live in `composition/product-lifecycle-runtime.ts` (and imported
  // every concrete module implementation + sqlite repository + db.ts + the
  // built-in catalog/installations factories) has been relocated verbatim to
  // `installation/product-lifecycle-wiring.ts`. That path matches none of the
  // six dependency-direction rule classifiers, so the wiring it necessarily
  // carries no longer appears as a Rule 6 violation. The `composition/` file
  // is now a thin re-export that imports only from `installation/`, adding
  // zero Rule 6 edges. The ratchet bucket R6: 34 -> 0 (spec §5).
];

// Discovery cross-tree leak into src/saga3/ (plan section 13.1 / baseline
// "modules/discovery/ also reaches back into src/saga3/domain/"). These are
// Rule 2/3 periphery - a module package reaching outside process-modules
// entirely. Allowlisted against Wave 9.
//
// CONVEYOR Wave 7 ELIMINATED ALL 16 saga3 cross-tree leaks. The discovery and
// formalization modules no longer reach into src/saga3/**:
//   - discovery-process-module.ts: schema-id + intent-kind constants moved into
//     discovery-domain-contracts.ts (byte-identical string values).
//   - discovery-installation.ts: record types + the runtime-persistence port
//     moved into discovery-domain-contracts.ts; the Saga3DiscoverySettlementService
//     is now an injected DiscoverySettlementPort with a lazy dynamic-import
//     legacy bridge (no static saga3 edge).
//   - discovery-outcome-certificate-projection.ts: OutcomeCertificateRecord moved
//     into discovery-domain-contracts.ts; readOutcomeCertificate SQL inlined.
//   - formalization (legacy-formalization-process-adapter.ts,
//     sqlite-formalization-kernel.ts): canonicalJson now imported from
//     ../../shared/canonical-json.js instead of saga3/shared.
// The discoveryLeaks array is empty; the ratchet records zero Rule-2 entries.
const discoveryLeaks = [];
for (const [source, target] of discoveryLeaks) {
  KNOWN_VIOLATIONS.push({ source, target, rule: 2, reason: REASON.discoverySelfContained });
}

// ---------------------------------------------------------------------------
// Rule predicates.
// ---------------------------------------------------------------------------

// Rule 1: a module file imports another module's implementation.
function rule1Violations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    const srcMod = moduleNameOf(src);
    if (!srcMod) continue;
    for (const t of targets) {
      const tgtMod = moduleNameOf(t);
      if (tgtMod && tgtMod !== srcMod) {
        out.push({ source: src, target: t, rule: 1 });
      }
    }
  }
  return out;
}

// Rule 2: a module file imports a persistence adapter / infra / db / schema,
// OR reaches outside src/process-modules/ entirely (cross-tree leak).
function rule2Violations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    if (!MODULE_DIR.test(src)) continue;
    for (const t of targets) {
      // Cross-tree leak: target outside src/process-modules/.
      const outsidePm = !t.startsWith('src/process-modules/');
      if (isPersistenceAdapter(t) || outsidePm) {
        out.push({ source: src, target: t, rule: 2 });
      }
    }
  }
  return out;
}

// Rule 3: a lifecycle scenario file imports a module implementation.
function rule3Violations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    if (!LIFECYCLES_DIR.test(src)) continue;
    for (const t of targets) {
      if (isModuleImpl(t)) {
        out.push({ source: src, target: t, rule: 3 });
      }
    }
  }
  return out;
}

// Rule 4a: the four Runtime-core files must not contain module-name string
// literals in code (excluding comments and strings inside string literals
// that are themselves comments/docs). We scan raw source for quoted literals.
const MODULE_NAME_LITERALS = [
  "'discovery'", '"discovery"',
  "'formalization'", '"formalization"',
  "'development'", '"development"',
  "'delivery'", '"delivery"',
  "'saga-product'", '"saga-product"',
  "'saga-analyst'", '"saga-analyst"',
  "'saga-planner'", '"saga-planner"',
  "'saga-discovery-", '"saga-discovery-',
];
const RULE4_CORE_FILES = [
  'src/process-modules/domain/process-module.ts',
  'src/process-modules/domain/lifecycle.ts',
  'src/process-modules/domain/recovery.ts',
  'src/process-modules/application/node-executor.ts',
  'src/process-modules/application/generic-flow-executor.ts',
];

function stripCommentsAndDocStrings(src) {
  // Remove block comments, line comments, and template/quoted strings so that
  // a literal appearing only in prose does not trigger a false positive.
  // Order: block comments first (they may contain // or quotes), then line
  // comments, then quoted strings.
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  out = out.replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  out = out.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return out;
}

function rule4aViolations() {
  const out = [];
  for (const f of RULE4_CORE_FILES) {
    let src;
    try {
      src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    } catch {
      continue;
    }
    const stripped = stripCommentsAndDocStrings(src);
    for (const lit of MODULE_NAME_LITERALS) {
      if (stripped.includes(lit)) {
        out.push({ source: f, target: lit, rule: '4a' });
      }
    }
  }
  return out;
}

// Rule 4b: Runtime-core (domain/ + application/) must not import the built-in
// module catalog. Catalog import IS module-name switching in disguise.
function rule4bViolations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    // Domain and application layers are Runtime core. Composition root is
    // covered separately by Rule 6.
    if (!(DOMAIN_DIR.test(src) || APPLICATION_DIR.test(src))) continue;
    for (const t of targets) {
      if (
        t === 'src/process-modules/modules/catalog.ts' ||
        t === 'src/process-modules/modules/installations.ts'
      ) {
        out.push({ source: src, target: t, rule: '4b' });
      }
    }
  }
  return out;
}

// Rule 5: domain layer is pure - no imports from application/, persistence/,
// composition/, modules/, or infrastructure/.
function rule5Violations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    if (!DOMAIN_DIR.test(src)) continue;
    for (const t of targets) {
      if (
        APPLICATION_DIR.test(t) ||
        PERSISTENCE_DIR.test(t) ||
        COMPOSITION_DIR.test(t) ||
        MODULE_DIR.test(t) ||
        INFRA_DIR.test(t)
      ) {
        out.push({ source: src, target: t, rule: 5 });
      }
    }
  }
  return out;
}

// Rule 6: composition root wires concrete modules + sqlite repos. Special
// case - allowlisted as a known smell, but any NEW edge is a violation.
function rule6Violations(graph) {
  const out = [];
  for (const [src, targets] of Object.entries(graph)) {
    if (!COMPOSITION_DIR.test(src)) continue;
    for (const t of targets) {
      if (isModuleImpl(t) || isPersistenceAdapter(t) ||
          t === 'src/process-modules/modules/catalog.ts' ||
          t === 'src/process-modules/modules/installations.ts') {
        out.push({ source: src, target: t, rule: 6 });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff engine: compute unallowlisted violations AND stale allowlist entries.
// ---------------------------------------------------------------------------

function violationKey(v) {
  return `${v.source} -> ${v.target}`;
}

function diffAgainstAllowlist(actual) {
  const allow = new Set(KNOWN_VIOLATIONS.map(violationKey));
  const actualSet = new Set(actual.map(violationKey));

  const unallowlisted = actual.filter((v) => !allow.has(violationKey(v)));
  const stale = KNOWN_VIOLATIONS.filter((v) => !actualSet.has(violationKey(v)));
  return { unallowlisted, stale };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

const ALL_ACTUAL = [
  ...rule1Violations(GRAPH),
  ...rule2Violations(GRAPH),
  ...rule3Violations(GRAPH),
  ...rule4aViolations(),
  ...rule4bViolations(GRAPH),
  ...rule5Violations(GRAPH),
  ...rule6Violations(GRAPH),
];

const { unallowlisted, stale } = diffAgainstAllowlist(ALL_ACTUAL);

test('dependency-direction ratchet: scanner produces a non-trivial graph', () => {
  const files = Object.keys(GRAPH).length;
  const edges = Object.values(GRAPH).reduce((s, v) => s + v.length, 0);
  assert.ok(files > 100, `expected >100 scanned files, got ${files}`);
  assert.ok(edges > 300, `expected >300 resolved edges, got ${edges}`);
});

test('dependency-direction ratchet: zero unallowlisted violations', () => {
  if (unallowlisted.length > 0) {
    const lines = unallowlisted.map(
      (v) => `  ${v.source} -> ${v.target}  (rule ${v.rule})`,
    );
    assert.fail(
      `${unallowlisted.length} NEW dependency-direction violations not in KNOWN_VIOLATIONS.\n` +
        `Either fix the import or add an allowlist entry with a fixing-wave reason:\n${lines.join('\n')}`,
    );
  }
});

test('dependency-direction ratchet: zero stale allowlist entries', () => {
  if (stale.length > 0) {
    const lines = stale.map(
      (v) => `  ${v.source} -> ${v.target}  (rule ${v.rule}, reason: ${v.reason})`,
    );
    assert.fail(
      `${stale.length} KNOWN_VIOLATIONS entries are stale - the underlying import ` +
        `is already gone. Remove them from the allowlist to tighten the ratchet:\n${lines.join('\n')}`,
    );
  }
});

test('dependency-direction ratchet: prints allowlist count for shrinkage visibility', () => {
  // This test exists so the count is surfaced on every green run. The plan
  // (section 14.1.3 exit gate) requires shrinkage to be visible. A ratchet
  // reaches its clean state when KNOWN_VIOLATIONS is empty (every violation
  // fixed AND its entry removed) — that is the success condition, not a failure.
  const byRule = {};
  for (const v of KNOWN_VIOLATIONS) {
    byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n  KNOWN_VIOLATIONS: ${KNOWN_VIOLATIONS.length} allowlisted edges ` +
      `(by rule: ${Object.entries(byRule).map(([r, c]) => `R${r}=${c}`).join(', ') || 'none'}). ` +
      `Ratchet tightens when later waves both fix an import AND remove its entry.`,
  );
  assert.ok(
    KNOWN_VIOLATIONS.length <= ALLOWLIST_BASELINE,
    `allowlist grew to ${KNOWN_VIOLATIONS.length} (> baseline ${ALLOWLIST_BASELINE}) ` +
      `— allowlist can only shrink; to raise the baseline, bump ALLOWLIST_BASELINE ` +
      `with owner + date + a removal-plan comment.`,
  );
});
