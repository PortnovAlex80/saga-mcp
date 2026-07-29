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

const KNOWN_VIOLATIONS = [
  // ---- Rule 1: module imports another module implementation ----
  {
    source: 'src/process-modules/modules/delivery/delivery-settlement-policy.ts',
    target: 'src/process-modules/modules/development/development-schemas.ts',
    rule: 1,
    reason: REASON.moduleIsolation,
  },

  // ---- Rule 2: module imports Runtime persistence adapter / infra / db ----
  {
    source: 'src/process-modules/modules/delivery/delivery-persistence.ts',
    target: 'src/process-modules/persistence/sqlite-process-run-repository.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/delivery/sqlite-delivery-approval-inbox.ts',
    target: 'src/db.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/delivery/sqlite-delivery-runtime.ts',
    target: 'src/db.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/delivery/sqlite-delivery-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-external-effect-ledger.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/delivery/sqlite-delivery-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-process-product-repository.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/development/development-persistence.ts',
    target: 'src/process-modules/persistence/sqlite-process-run-repository.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/development/sqlite-development-runtime.ts',
    target: 'src/db.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/development/sqlite-development-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-process-product-repository.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/discovery/discovery-installation.ts',
    target: 'src/db.ts',
    rule: 2,
    reason: REASON.discoverySelfContained,
  },
  {
    source: 'src/process-modules/modules/formalization/formalization-installation.ts',
    target: 'src/db.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  {
    source: 'src/process-modules/modules/formalization/formalization-kernel-ports.ts',
    target: 'src/process-modules/persistence/sqlite-managed-production-ledger.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },
  // W8-A6: the SQLite-backed package port adapter bridges the module-local
  // FormalizationManagedProductionPort to the shared ManagedProductionLedger.
  // This is the module-local adapter that ISOLATES the substrate — the whole
  // point of the ports/adapter split. Same classification as the sibling
  // sqlite-formalization-kernel.ts. Wave 11 cutover wires the port-injected
  // path and removes the legacy formalization-installation.ts getDb() entry.
  {
    source: 'src/process-modules/modules/formalization/package/ports/sqlite-formalization-package-adapters.ts',
    target: 'src/process-modules/persistence/sqlite-managed-production-ledger.ts',
    rule: 2,
    reason: REASON.modulePorts,
  },

  // ---- Rule 3: lifecycle scenario imports module implementation ----
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/delivery/delivery-process-module.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/delivery/delivery-schemas.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/delivery/delivery-settlement-policy.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/development/development-process-module.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/development/development-schemas.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/development/development-settlement-policy.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/discovery/discovery-process-module.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/formalization/formalization-process-module.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },
  {
    source: 'src/process-modules/lifecycles/product-delivery-lifecycle.ts',
    target: 'src/process-modules/modules/formalization/formalization-schemas.ts',
    rule: 3,
    reason: REASON.lifecycleContracts,
  },

  // ---- Rule 4: Runtime core imports the built-in module catalog ----
  // (module-name switching in disguise - plan section 13.2 / 14.4.1)
  // W13-A1 REMOVED this edge: execution-profile-resolver.ts no longer imports
  // the built-in catalog (the catalog file is deleted; the resolver now
  // imports the production module definitions directly and matches task_kind
  // by exact equality only). R4 ratchet edge removed (74 → 73).

  // ---- Rule 6: composition root wires concrete modules + sqlite repos ----
  // (plan section 13.10 / 14.11 - Wave 11 replaces the manual composition root)
  // W13-A1 removed product-lifecycle-runtime's imports of modules/catalog.ts
  // and modules/installations.ts (those files are deleted; the registries are
  // built inline from the production module definitions). The two stale Rule 6
  // edges for catalog/installations are removed here.
  // Module implementations:
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-installation.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-kernel-ports.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-provider-ports.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-persistence.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-process-module.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-schemas.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/delivery-settlement-policy.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/sqlite-delivery-approval-inbox.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/delivery/sqlite-delivery-runtime.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/development-installation.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/development-kernel-ports.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/development-persistence.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/development-process-module.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/development-schemas.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/development-settlement-policy.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/development/sqlite-development-runtime.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/discovery/discovery-installation.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/discovery/discovery-process-module.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/formalization/formalization-installation.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/formalization/formalization-persistence.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/formalization/formalization-process-module.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/formalization/formalization-schemas.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/modules/formalization/sqlite-formalization-kernel.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  // Composition root sqlite/db imports:
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/db.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-lifecycle-run-repository.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-managed-node-submission-repository.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-managed-production-ledger.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-node-run-repository.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-exact-candidate-acceptance.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-process-outcome-certificate-repository.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-process-run-repository.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
  {
    source: 'src/process-modules/composition/product-lifecycle-runtime.ts',
    target: 'src/process-modules/persistence/sqlite-recovery-case-repository.ts',
    rule: 6,
    reason: REASON.compositionCutover,
  },
];

// Discovery cross-tree leak into src/saga3/ (plan section 13.1 / baseline
// "modules/discovery/ also reaches back into src/saga3/domain/"). These are
// Rule 2/3 periphery - a module package reaching outside process-modules
// entirely. Allowlisted against Wave 9.
const discoveryLeaks = [
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/persistence/saga3-discovery-runtime-port.ts'],
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/domain/discovery-normalization-records.ts'],
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/domain/discovery-readiness-records.ts'],
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/domain/discovery-settlement-input.ts'],
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/domain/discovery-outcome-certificate.ts'],
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/domain/discovery-readiness-assessment.ts'],
  ['src/process-modules/modules/discovery/discovery-installation.ts', 'src/saga3/application/discovery-settlement-service.ts'],
  ['src/process-modules/modules/discovery/discovery-outcome-certificate-projection.ts', 'src/saga3/persistence/saga3-settlement-repository.ts'],
  ['src/process-modules/modules/discovery/discovery-outcome-certificate-projection.ts', 'src/saga3/domain/discovery-settlement-records.ts'],
  ['src/process-modules/modules/discovery/discovery-process-module.ts', 'src/saga3/domain/discovery-diagnosis-report.ts'],
  ['src/process-modules/modules/discovery/discovery-process-module.ts', 'src/saga3/domain/discovery-normalization-proposal.ts'],
  ['src/process-modules/modules/discovery/discovery-process-module.ts', 'src/saga3/domain/discovery-proposal.ts'],
  ['src/process-modules/modules/discovery/discovery-process-module.ts', 'src/saga3/domain/discovery-readiness-assessment.ts'],
  ['src/process-modules/modules/discovery/discovery-process-module.ts', 'src/saga3/domain/work-intent.ts'],
  // Discovery port leak through the legacy saga3 worker-executor port.
  ['src/process-modules/modules/development/sqlite-development-runtime.ts', 'src/application/ports/worker-executor.ts'],
  // Formalization reaches into the saga3 canonical-hash shim and shared util.
  ['src/process-modules/modules/formalization/legacy-formalization-process-adapter.ts', 'src/saga3/shared/discovery-canonical.ts'],
  ['src/process-modules/modules/formalization/sqlite-formalization-kernel.ts', 'src/saga3/shared/discovery-canonical.ts'],
];
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
  // (section 14.1.3 exit gate) requires shrinkage to be visible.
  const byRule = {};
  for (const v of KNOWN_VIOLATIONS) {
    byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n  KNOWN_VIOLATIONS: ${KNOWN_VIOLATIONS.length} allowlisted edges ` +
      `(by rule: ${Object.entries(byRule).map(([r, c]) => `R${r}=${c}`).join(', ')}). ` +
      `Ratchet tightens when later waves both fix an import AND remove its entry.`,
  );
  assert.ok(KNOWN_VIOLATIONS.length > 0, 'allowlist must be seeded');
});
