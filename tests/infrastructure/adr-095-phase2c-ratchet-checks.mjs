// tests/infrastructure/adr-095-phase2c-ratchet-checks.mjs
//
// ADR-095 Phase-2C — the machine surface of the EIGHT-RATCHET set.
//
// This is NOT a test file (no *.test.mjs suffix, hosted by no matrix glob).
// It exports the STATE READERS and the PURE RATCHET CHECKERS consumed by
// tests/architecture/adr-095-ratchet-suite.test.mjs (blocking, architecture
// group) and by the phase executors later in the ADR-095 commit-train.
// Keeping the checkers pure (data in -> errors out) is what makes the
// non-vacuity proofs honest: every ratchet's failure mode is demonstrated by
// feeding it a MUTATED snapshot and asserting the exact error, on the same
// code path the real tree takes.
//
// State model (no hand-maintained flags — every discriminator is derived):
//   phase4Landed    the product-discovery module identity version is STRICTLY
//                   GREATER than the censused legacy baseline (3.0.2). The
//                   atomic version bump is the ADR-095 Decision-4 phase-4
//                   boundary: it cannot be flipped by reintroducing a single
//                   file, so mutations cannot slide the ratchet back to the
//                   permissive arm. src and dist must agree (build coherence).
//   closureInSchema the fresh-DB DDL still creates at least one of the ten
//                   dead phase-5 tables (phase-5 boundary).
//
// Ratchet ownership map (ADR-095 "Ratchets" 1..8 — see the suite header):
//   R1 shrinking allowlist          -> checkR1  (+ BR3 dead-edge denial)
//   R2 one-handler manifest/digest  -> checkR2  (+ handler-digest-runtime-
//                                      consistency generic digest re-pin)
//   R3 src symbol/table absence     -> checkR3
//   R4 dist-aware absence           -> checkR4
//   R5 fresh DB lacks the closure   -> checkR5 (+ createFreshDbObjects)
//   R6 live v2 behavior             -> hosted discovery-live-v2 group +
//                                      factory-proof discovery packs (no new
//                                      oracle here; hosting pinned by G2i)
//   R7 existing-DB boot             -> discovery-legacy-removal-boot-
//                                      regression (G2h); spawned-engine smoke
//                                      lands with Phase 4
//   R8 mutation RED/GREEN           -> the suite's mutation negatives below
//                                      + Phase-6 deliberate cycle (recorded)

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { ADR_095_INVENTORY } from './adr-095-removal-inventory.mjs';

const INVENTORY = ADR_095_INVENTORY;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function semverGt(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  return out;
}

function readText(repoRoot, rel) {
  return fs.readFileSync(path.join(repoRoot, ...rel.split('/')), 'utf8');
}

function sha256File(absPath) {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function walkFiles(absDir, filter, out = []) {
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const p = path.join(absDir, entry.name);
    if (entry.isDirectory()) walkFiles(p, filter, out);
    else if (!filter || filter.test(entry.name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// state readers
// ---------------------------------------------------------------------------

/** Reads the discovery module identity version pinned in a contracts file. */
export function readDiscoveryVersionFromSource(source) {
  const m = source.match(/DISCOVERY_PROCESS_MODULE_REF\s*=\s*\{[\s\S]*?version:\s*'([^']+)'/);
  return m ? m[1] : null;
}

/**
 * Collects the full ratchet state from the tree. `overrides` lets tests
 * replace individual facts (the mutation-negative hook) without touching
 * disk: every checker takes its facts as plain data.
 */
export async function readRatchetState(repoRoot, overrides = {}) {
  const contractsRel = INVENTORY.moduleIdentity.versionPinPath;
  const srcVersion = readDiscoveryVersionFromSource(readText(repoRoot, contractsRel));

  const distContracts = path.join(repoRoot, 'dist', 'process-modules', 'lifecycles', 'product-delivery-module-contracts.js');
  const distVersion = fs.existsSync(distContracts)
    ? readDiscoveryVersionFromSource(fs.readFileSync(distContracts, 'utf8'))
    : null;

  const legacyVersion = INVENTORY.moduleIdentity.version;
  const versionCoherent = srcVersion !== null && srcVersion === distVersion;
  const phase4Landed = versionCoherent && semverGt(srcVersion, legacyVersion);

  const deadFilesRemaining = INVENTORY.deadPhase4Files
    .map((e) => e.path)
    .filter((p) => fs.existsSync(path.join(repoRoot, ...p.split('/'))));

  const distSchemaPath = path.join(repoRoot, 'dist', 'schema.js');
  let closureInSchema = null;
  if (fs.existsSync(distSchemaPath)) {
    const schemaText = fs.readFileSync(distSchemaPath, 'utf8');
    closureInSchema = INVENTORY.deadPhase5Tables.some(
      (t) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(schemaText),
    );
  }

  const distFiles = new Set(
    walkFiles(path.join(repoRoot, 'dist'), /\.(js|d\.ts)$/)
      .map((p) => toPosix(path.relative(repoRoot, p))),
  );

  const state = {
    srcVersion,
    distVersion,
    versionCoherent,
    phase4Landed,
    deadFilesRemaining,
    closureInSchema,
    distFiles,
    distAvailable: distFiles.size > 0,
  };
  return { ...state, ...overrides };
}

/** The manifest facts ratchet 2 observes (dist = the executed bytes). */
export async function readManifestFacts(repoRoot) {
  const manifestPath = path.join(
    repoRoot, 'dist', 'process-modules', 'modules', 'discovery', 'package', 'manifest.js',
  );
  const manifest = await import(pathToFileURL(manifestPath).href);
  const deadDistPath = path.join(
    repoRoot, 'dist', 'modules', 'discovery', 'application', 'discovery-installation.js',
  );
  const prodDistPath = path.join(
    repoRoot, 'dist', 'modules', 'discovery', 'application', 'discovery-production-cell-installation.js',
  );
  return {
    handlerIdsValues: Object.values(manifest.DISCOVERY_HANDLER_IDS ?? {}),
    handlerRefs: (manifest.DISCOVERY_HANDLER_REFS ?? []).map((r) => ({
      logicalId: r.logicalId,
      version: r.version,
      digest: r.digest,
    })),
    deadDistExists: fs.existsSync(deadDistPath),
    deadDistDigest: fs.existsSync(deadDistPath) ? sha256File(deadDistPath) : null,
    productionCellExists: fs.existsSync(prodDistPath),
    productionCellDigest: fs.existsSync(prodDistPath) ? sha256File(prodDistPath) : null,
  };
}

/**
 * Creates a FRESH database through the production entry (dist/db.js getDb:
 * pragmas + SCHEMA_SQL + ensure ladders) and returns its sqlite_master
 * objects. Ratchet 5's ground truth — never a SCHEMA_SQL text scan.
 */
export async function createFreshDbObjects(repoRoot) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'adr095-r5-'));
  process.env.DB_PATH = path.join(temp, 'fresh.db');
  try {
    const { getDb, closeDb } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'db.js')).href);
    const db = getDb();
    const rows = db
      .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
      .all();
    closeDb();
    return {
      tables: new Set(rows.filter((r) => r.type === 'table').map((r) => r.name)),
      indexes: new Set(rows.filter((r) => r.type === 'index').map((r) => r.name)),
    };
  } finally {
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Comment-stripped src/*.ts scan map for ratchet 3 (rel path -> code text). */
export function readSrcScan(repoRoot) {
  const entries = [];
  for (const abs of walkFiles(path.join(repoRoot, 'src'), /\.ts$/)) {
    const rel = toPosix(path.relative(repoRoot, abs));
    entries.push([rel, stripComments(fs.readFileSync(abs, 'utf8'))]);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// R1 — shrinking allowlist (ratchet 1)
// ---------------------------------------------------------------------------

const R1_DISCOVERY_SCOPES = [
  'src/modules/discovery/',
  'src/process-modules/modules/discovery/',
  'src/tools/discovery-proposal-tools.ts',
  'src/tools/discovery-normalization-tools.ts',
  'src/tools/discovery-readiness-tools.ts',
  'src/tools/discovery-tool-args.ts',
];

function isInDiscoveryScope(p) {
  return R1_DISCOVERY_SCOPES.some((s) => p === s || p.startsWith(s));
}

function extractArrayLiteralBlockFailClosed(src, declaration, errors) {
  const decl = src.indexOf(declaration);
  if (decl === -1) {
    errors.push(`R1: declaration not found in dependency-direction.test.mjs: ${declaration} (fail closed)`);
    return null;
  }
  const open = src.indexOf('[', decl + declaration.length);
  const close = src.indexOf('];', open);
  if (open === -1 || close === -1) {
    errors.push(`R1: array literal terminator ('];') not found for: ${declaration} (fail closed)`);
    return null;
  }
  return src.slice(open, close);
}

/**
 * Ratchet 1 facts from the dependency-direction test source:
 *   baseline        the parsed ALLOWLIST_BASELINE ceiling
 *   discoveryEdges  every allowlisted edge (source or target) inside the
 *                   Discovery scoped trees — must be ZERO at every phase
 *                   (legacy death may never become allowlist debt)
 *   errorCount      total KNOWN_VIOLATIONS entries (monotone-shrink evidence)
 */
export function checkR1(depTestSource) {
  const errors = [];
  const baselineMatch = depTestSource.match(/const ALLOWLIST_BASELINE = (\d+)/);
  if (!baselineMatch) {
    errors.push('R1: ALLOWLIST_BASELINE declaration not found (fail closed)');
    return { errors };
  }
  const baseline = Number(baselineMatch[1]);
  const facts = { baseline, discoveryEdges: [], errorCount: 0 };

  if (baseline > 1) {
    errors.push(
      `R1: ALLOWLIST_BASELINE grew to ${baseline} — the discovery-era ceiling is 1 and the ` +
        'allowlist may only shrink (ADR-095 ratchet 1); raising it requires a reviewed decision, not a number edit',
    );
  }

  const block = extractArrayLiteralBlockFailClosed(depTestSource, 'const KNOWN_VIOLATIONS = ', errors);
  const appendBlock = extractArrayLiteralBlockFailClosed(depTestSource, 'const discoveryLeaks = ', errors);
  if (block === null || appendBlock === null) return { errors, facts };

  facts.errorCount = block.match(/source:\s*'[^']+'/g)?.length ?? 0;

  // Collect every quoted src path in BOTH blocks: KNOWN_VIOLATIONS entries
  // are object literals ({ source: '...', target: '...' }) while the
  // discoveryLeaks push site carries tuple literals ([['src/...', 'src/...']])
  // — the scoped-edge denial must hold for both shapes.
  const quoted = [
    ...(block.match(/'(src\/[^']+)'/g) ?? []),
    ...(appendBlock.match(/'(src\/[^']+)'/g) ?? []),
  ].map((s) => s.slice(1, -1));
  for (const p of quoted) {
    if (isInDiscoveryScope(p)) facts.discoveryEdges.push(p);
  }
  if (facts.discoveryEdges.length > 0) {
    errors.push(
      `R1: the dependency-direction allowlist carries Discovery-scoped edges ` +
        `(${[...new Set(facts.discoveryEdges)].join(', ')}) — the ADR-095 end state is ZERO ` +
        'discovery-legacy entries; deleting the legacy files must remove edges, never grandfather them',
    );
  }
  return { errors, facts };
}

// ---------------------------------------------------------------------------
// R2 — exact one-handler manifest/digest across the versioned boundary
// ---------------------------------------------------------------------------

/**
 * Two armed ratchet keyed on the ATOMIC module-version marker:
 *  - pre  (version == legacy 3.0.2): the manifest must hold the EXACT censused
 *          six-handler baseline — six ids, six refs, one shared digest equal to
 *          the sha256 of the executed dead dist bytes. Any drift (a partial
 *          repin, a five-ref manifest, a digest flip at 3.0.2) is the F5
 *          half-migration shape and is RED here.
 *  - post (version > 3.0.2): exactly ONE ref (discovery-settlement-policy)
 *          whose digest equals the sha256 of the executed production-cell
 *          dist bytes, with a bumped handler version, and no retired id
 *          anywhere in the declared surface.
 */
export function checkR2(state, manifestFacts) {
  const errors = [];
  const legacy = INVENTORY.moduleIdentity.version;
  const legacyIds = [...INVENTORY.legacyHandlerIds];
  const retired = legacyIds.filter((id) => id !== INVENTORY.liveHandlerId);

  if (manifestFacts.srcVersion !== manifestFacts.distVersion) {
    errors.push(
      `R2: module-version marker incoherent — src pins ${manifestFacts.srcVersion} while dist ` +
        `carries ${manifestFacts.distVersion}: rebuild (npm run build) before the ratchet can testify`,
    );
    return errors;
  }
  const version = manifestFacts.srcVersion;
  if (version === null) {
    errors.push('R2: could not read the product-discovery version marker (fail closed)');
    return errors;
  }

  const { handlerIdsValues, handlerRefs } = manifestFacts;
  const refIds = handlerRefs.map((r) => r.logicalId);
  const retiredPresent = [...handlerIdsValues, ...refIds].filter((id) => retired.includes(id));

  if (!semverGt(version, legacy)) {
    // ---- pre-cutover arm: the exact censused six-handler baseline --------
    const expected = [...legacyIds].sort();
    const got = [...handlerIdsValues].sort();
    if (got.join('|') !== expected.join('|')) {
      errors.push(
        `R2: pre-cutover manifest drifted from the censused six-handler baseline (expected ` +
          `${expected.join(', ')}; got ${got.join(', ') || 'none'}) — at version ${legacy} the six ` +
          'stale pins are the recorded truth; the ONLY legal change is the atomic phase-4 ' +
          'version-bump cutover (ADR-095 Decision 4 / F5 STOP-SHIP)',
      );
    }
    if (refIds.length !== legacyIds.length || [...refIds].sort().join('|') !== expected.join('|')) {
      errors.push(
        `R2: pre-cutover DISCOVERY_HANDLER_REFS must hold exactly the censused six refs ` +
          `(got ${refIds.length}: ${refIds.join(', ') || 'none'}) — a reduced set at ${legacy} is the ` +
          'same-version drift shape that fatalizes existing DBs (MODULE_INSTALLATION_INCOMPATIBLE_DRIFT)',
      );
    }
    if (!manifestFacts.deadDistExists) {
      errors.push(
        'R2: pre-cutover arm requires the executed dead dist bytes ' +
          '(dist/modules/discovery/application/discovery-installation.js) to exist for digest comparison',
      );
    } else {
      const digests = new Set(handlerRefs.map((r) => r.digest));
      const digestOk = digests.size === 1 && [...digests][0] === manifestFacts.deadDistDigest;
      if (!digestOk) {
        errors.push(
          'R2: pre-cutover handler digests must all equal the sha256 of the executed ' +
            `discovery-installation.js bytes (expected ${String(manifestFacts.deadDistDigest).slice(0, 12)}…; ` +
            `got ${[...digests].map((d) => String(d).slice(0, 12)).join(', ')})`,
        );
      }
    }
    const refVersions = new Set(handlerRefs.map((r) => r.version));
    if (refVersions.size !== 1 || [...refVersions][0] !== '1.0.0') {
      errors.push(
        `R2: pre-cutover handler refs carry the censused handler version 1.0.0 (got ` +
          `${[...refVersions].join(', ')}) — the version bump is reserved for the atomic cutover commit`,
      );
    }
  } else {
    // ---- post-cutover arm: exactly the one live ref, production-cell bytes
    if (handlerRefs.length !== 1) {
      errors.push(
        `R2: post-cutover manifest must declare EXACTLY ONE handler ref (got ${handlerRefs.length}: ` +
          `${refIds.join(', ') || 'none'}) — ADR-095 ratchet 2`,
      );
    }
    for (const r of handlerRefs) {
      if (r.logicalId !== INVENTORY.liveHandlerId) {
        errors.push(
          `R2: post-cutover ref logicalId must be ${INVENTORY.liveHandlerId} (got ${r.logicalId})`,
        );
      }
      if (!manifestFacts.productionCellExists) {
        errors.push(
          'R2: post-cutover arm requires the executed production-cell dist bytes ' +
            '(dist/modules/discovery/application/discovery-production-cell-installation.js) for digest comparison',
        );
      } else if (r.digest !== manifestFacts.productionCellDigest) {
        errors.push(
          `R2: post-cutover ref digest ${String(r.digest).slice(0, 12)}… != sha256 of the executed ` +
            `production-cell dist bytes ${String(manifestFacts.productionCellDigest).slice(0, 12)}… (ADR-095 F3)`,
        );
      }
      if (!semverGt(r.version, '1.0.0')) {
        errors.push(
          `R2: post-cutover handler ref version must be bumped above the legacy 1.0.0 (got ${r.version}) ` +
            '— ADR-095 Decision 4 requires the handler version bump in the same atomic commit',
        );
      }
    }
    if (retiredPresent.length > 0) {
      errors.push(
        `R2: retired handler ids still declared post-cutover (${[...new Set(retiredPresent)].join(', ')})`,
      );
    }
    const liveIds = [...handlerIdsValues];
    if (liveIds.length !== 1 || liveIds[0] !== INVENTORY.liveHandlerId) {
      errors.push(
        `R2: post-cutover DISCOVERY_HANDLER_IDS must reduce to exactly [${INVENTORY.liveHandlerId}] ` +
          `(got ${liveIds.join(', ') || 'none'})`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// R3 — full src symbol/table absence (ratchet 3)
// ---------------------------------------------------------------------------

function buildAllowedSets(phase4Landed, closureInSchema) {
  const deadSet = new Set([
    ...INVENTORY.deadPhase4Files.map((e) => e.path),
    ...INVENTORY.deadPhase4Resources.map((e) => e.path),
  ]);
  const empty = () => new Set();
  const symbolAllowed = phase4Landed
    ? () => empty()
    : (list) => new Set([...deadSet, ...list.map((e) => (typeof e === 'string' ? e : e.path))]);
  return { deadSet, symbolAllowed };
}

/**
 * Scans comment-stripped src text for every removal symbol outside its
 * allowed live sites. `scanEntries` is an iterable of [relPath, text] so
 * mutation negatives can inject virtual files. Tables/indexes follow the
 * PHASE-5 boundary (allowed only in schema.ts while the closure DDL exists —
 * plus the settlement-debug legacy query host pre-cutover); all other symbol
 * classes follow the PHASE-4 boundary (allowed live sites empty post-bump).
 */
export function checkR3(scanEntries, phase4Landed, closureInSchema) {
  const errors = [];
  const { deadSet, symbolAllowed } = buildAllowedSets(phase4Landed, closureInSchema);
  const symbols = INVENTORY.removalSymbols;

  const tableAllowed = new Set(deadSet);
  if (closureInSchema) tableAllowed.add('src/schema.ts');
  if (!phase4Landed) {
    tableAllowed.add('src/tools/settlement-debug.ts');
  }
  const tableSpecificAllowed = (table) => {
    if (phase4Landed) return new Set(deadSet);
    const specific = symbols.tableAllowedOutsideSpecific[table] ?? [];
    return new Set([...deadSet, ...specific]);
  };

  const matchers = [];
  for (const t of symbols.pathTokens) {
    const allowed = symbolAllowed(t.allowedOutside);
    const re = new RegExp(`[/']${t.token.slice(1)}\\.(?:ts|js)\\b`);
    matchers.push({ kind: `dead module import (${t.token})`, re, allowed, global: true });
  }
  for (const s of symbols.namedSymbols) {
    const allowed = symbolAllowed(s.allowedOutside);
    const re = new RegExp(`\\b${s.symbol}\\b`);
    matchers.push({ kind: `dead symbol (${s.symbol})`, re, allowed, global: true });
  }
  for (const id of symbols.manifestDeadLaneLogicalIds) {
    const allowed = phase4Landed ? new Set() : new Set([...deadSet, ...symbols.manifestDeadLaneAllowedIn]);
    const re = new RegExp(`['"\`]${id}['"\`]`);
    matchers.push({ kind: `dead manifest lane (${id})`, re, allowed, global: true });
  }
  for (const t of INVENTORY.deadPhase5Tables) {
    const allowed = closureInSchema
      ? new Set([...tableAllowed, ...tableSpecificAllowed(t)])
      : new Set(deadSet);
    const re = new RegExp(`\\b${t}\\b`);
    matchers.push({ kind: `dead table (${t})`, re, allowed, global: true });
  }
  for (const i of INVENTORY.deadPhase5Indexes) {
    const allowed = closureInSchema ? new Set(tableAllowed) : new Set(deadSet);
    const re = new RegExp(`\\b${i}\\b`);
    matchers.push({ kind: `dead index (${i})`, re, allowed, global: true });
  }

  for (const [rel, text] of scanEntries) {
    for (const m of matchers) {
      if (m.allowed.has(rel)) continue;
      if (m.re.test(text)) {
        errors.push(
          `R3: ${m.kind} referenced OUTSIDE its allowed sites in src file: ${rel}` +
            (phase4Landed ? ' (post-cutover: allowed sites are EMPTY — reintroduction is forbidden)'
              : ' (see the pinned allowedOutside set in the removal inventory)'),
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// R4 — dist-aware clean-build absence (ratchet 4)
// ---------------------------------------------------------------------------

function distEmissionsFor(deadRel, distFiles) {
  const js = deadRel.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
  const dts = js + '.d.ts'; // emitted only when declarations are on; harmless if absent
  return [...new Set([js, dts])].filter((p) => distFiles.has(p));
}

/**
 * Pre-cutover: every dead src file still on disk MUST have its emitted dist
 * counterpart (clean-build faithfulness — otherwise the post-arm's absence
 * testimony would be a stale-dist artifact). Post-cutover: NO emitted file of
 * ANY dead module may exist under dist/ (a survivor means the deletion
 * happened without a clean rebuild, or a dead file came back and was rebuilt).
 */
export function checkR4(state) {
  const errors = [];
  const { phase4Landed, deadFilesRemaining, distFiles, distAvailable } = state;
  if (!distAvailable) {
    errors.push('R4: dist/ is empty or missing — the ratchet testifies only over a clean build (npm run build)');
    return errors;
  }
  if (!phase4Landed) {
    for (const dead of deadFilesRemaining) {
      const js = dead.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
      if (!distFiles.has(js)) {
        errors.push(
          `R4: dead src file present without its emitted counterpart — dist is STALE: ${dead} -> ` +
            `${js} missing (rebuild before trusting any dist-based ratchet)`,
        );
      }
    }
    return errors;
  }
  for (const e of INVENTORY.deadPhase4Files) {
    const emitted = distEmissionsFor(e.path, distFiles);
    if (emitted.length > 0) {
      errors.push(
        `R4: dist still contains emitted files of the REMOVED module ${e.path}: ${emitted.join(', ')} ` +
          '— the cutover requires a clean rebuild in the same commit (ADR-095 ratchet 4 / F6)',
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// R5 — fresh DB lacks the full closure (ratchet 5)
// ---------------------------------------------------------------------------

/**
 * State machine over (phase4Landed, closure visible in a FRESH database):
 *   (false, closure present) -> assert the closure is COMPLETE (all ten
 *       tables + all nineteen indexes) — a partial DDL edit is RED;
 *   (false, closure absent)  -> RED: the schema closure was removed BEFORE
 *       the code cutover — the F2 ordering violation (lazy recreation sites
 *       would still exist);
 *   (true,  closure present) -> legitimate phase-4 -> phase-5 intermediate:
 *       writers are gone, tables inert; assert completeness (no partial);
 *   (true,  closure absent)  -> the phase-5 end state: all ten tables AND all
 *       nineteen indexes absent; factory_work_intents still present.
 * Reintroducing ONE legacy CREATE TABLE post-phase-5 lands in the
 * (true, partial) corner: the completeness assertion names every missing
 * table — RED.
 */
export function checkR5(freshDbObjects, phase4Landed) {
  const errors = [];
  const { tables, indexes } = freshDbObjects;
  const deadTables = INVENTORY.deadPhase5Tables;
  const deadIndexes = INVENTORY.deadPhase5Indexes;

  const presentTables = deadTables.filter((t) => tables.has(t));
  const presentIndexes = deadIndexes.filter((i) => indexes.has(i));
  const closurePresent = presentTables.length > 0 || presentIndexes.length > 0;

  for (const t of INVENTORY.keptLive.keptTables) {
    if (!tables.has(t)) {
      errors.push(`R5: kept live table MISSING from the fresh DB: ${t} (never part of the removal)`);
    }
  }

  if (!closurePresent) {
    if (!phase4Landed) {
      errors.push(
        'R5: the fresh schema no longer creates the legacy closure while the phase-4 cutover has ' +
          'NOT landed (version marker still at the legacy baseline) — ADR-095 Decision 3 / F2: the ' +
          'schema closure is removed only AFTER the code deletion and version bump',
      );
    }
    // phase-5 end state: nothing more to assert (absence already proven).
    return errors;
  }

  const missingTables = deadTables.filter((t) => !tables.has(t));
  const missingIndexes = deadIndexes.filter((i) => !indexes.has(i));
  if (missingTables.length > 0 || missingIndexes.length > 0) {
    errors.push(
      `R5: PARTIAL legacy closure in the fresh DB — present: [${presentTables.join(', ') || 'no tables'} / ` +
        `${presentIndexes.join(', ') || 'no indexes'}]; missing: [${missingTables.join(', ') || '-'} / ` +
        `${missingIndexes.join(', ') || '-'}]. The closure is removed ATOMICALLY (one commit) or not at ` +
          'all; reintroducing individual legacy CREATE TABLE statements is a ratchet-8 mutation and is RED',
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// aggregate (used by the suite and by the evidence script)
// ---------------------------------------------------------------------------

export function summarize(errors) {
  return errors.length === 0 ? 'GREEN (no errors)' : `RED (${errors.length}): ${errors.join(' | ')}`;
}
