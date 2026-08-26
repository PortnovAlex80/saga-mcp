#!/usr/bin/env node
/**
 * tools/qualify/kit.mjs - the IMMUTABLE QUALIFICATION KIT (WP-15, plan
 * EK-11 "Immutable kit"): freezes ONE source SHA with its build, kernel
 * fingerprints and qualification inputs into a content-addressed manifest,
 * and re-verifies every digest on every driver start.
 *
 * The kit binds (plan EK-11 checklist):
 *   - one source SHA (git HEAD) + a CLEAN tree proof;
 *   - the clean-dist proof (the deterministic dist tree hash + file count);
 *   - package.json / package-lock.json digests + the installed runtime
 *     package digests (node_modules/<dep>/package.json of every runtime
 *     dependency the built kernel imports);
 *   - the kernel schema fingerprint (SCHEMA_FINGERPRINT of the persistence
 *     schema) and the scenario-universe digest (the closed command/event/
 *     obligation/wait/proof/evidence vocabularies);
 *   - the actor version (the testing actor vocabulary + the scripted
 *     channel module digest);
 *   - the complexity-budget digest, the role-contract manifest digest, the
 *     PromptBudgetProfile digest (the exact profile object the runs pin,
 *     hashed with the runtime's own formula) and the token-counter identity;
 *   - admissionContractDigest (recomputed with the validator's formula) and
 *     the preserved EK admission-receipt digest;
 *   - OS, Node/npm versions, environment, and the scenario seed.
 *
 * Commands:
 *   node tools/qualify/kit.mjs --freeze [--seed <uint32>]
 *   node tools/qualify/kit.mjs --verify --kit <path-or-id>
 *
 * A kit manifest is CONTENT-ADDRESSED: kitId = sha256(canonical(core)); the
 * file lives at docs/refactoring/event-kernel/qualification/kits/<kitId>.json
 * and is immutable (a same-id file with different content refuses). Kit
 * manifests are the only untracked artefacts the clean-tree fence tolerates.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

import {
  canonicalJson, sha256Of, sha256File, collectTree, distTreeHash, environmentBlock,
} from './lib/fences.mjs';

export const KIT_KIND = 'ek-qualification-kit';
export const KIT_VERSION = 1;
export const KITS_DIR = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification', 'kits');
export const DEFAULT_SEED = 20260826;

/* ------------------------------------------------------------------ */
/* Kernel fingerprint collection                                       */
/* ------------------------------------------------------------------ */

const importDist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);

/** The runtime dependencies the built kernel imports (scanned from dist). */
function kernelRuntimeDependencies() {
  const distDir = join(REPO_ROOT, 'dist');
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.js')) sources.push(readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  walk(distDir);
  const text = sources.join('\n');
  const candidates = new Set();
  for (const match of text.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)) candidates.add(match[1].split('/')[0]);
  for (const match of text.matchAll(/require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g)) candidates.add(match[1].split('/')[0]);
  const builtin = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url', 'node:os', 'node:http', 'node:child_process', 'node:assert', 'node:util', 'node:events', 'node:sqlite', 'node:test', 'node:stream', 'node:net', 'node:timers', 'node:process']);
  return [...candidates].filter((name) => !builtin.has(name) && !name.startsWith('node:')).sort();
}

/** Digests of the installed runtime packages the kernel imports. */
export function installedPackageDigests() {
  const names = kernelRuntimeDependencies();
  const packages = {};
  const lockDigest = sha256File(join(REPO_ROOT, 'package-lock.json'));
  for (const name of names) {
    const manifest = join(REPO_ROOT, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) {
      throw Object.assign(new Error(`QUALIFY_PACKAGE_MISSING: runtime dependency ${name} is not installed`), { code: 'QUALIFY_PACKAGE_MISSING' });
    }
    packages[name] = sha256File(manifest);
  }
  return { lockDigest, packages };
}

/** The scenario-universe digest: the closed vocabularies, canonicalized. */
export async function universeDigest() {
  const universe = await importDist('workflow-kernel/domain/universe.js');
  const document = {
    schemaVersion: universe.UNIVERSE_SCHEMA_VERSION,
    aggregates: universe.AGGREGATE_NAMES,
    commands: universe.COMMAND_NAMES,
    events: universe.WORKFLOW_EVENT_KINDS,
    obligations: universe.OBLIGATION_KINDS,
    waits: universe.WAIT_KINDS,
    proofs: universe.PROOF_KINDS,
    evidence: universe.EVIDENCE_KINDS,
  };
  return { digest: sha256Of(canonicalJson(document)), schemaVersion: universe.UNIVERSE_SCHEMA_VERSION, commandCount: universe.COMMAND_NAMES.length };
}

/** The actor version: the testing actor vocabulary + module digests. */
export async function actorVersion() {
  const actors = await importDist('workflow-kernel/testing/actors.js');
  const document = {
    behaviors: actors.ACTOR_BEHAVIORS,
    roles: actors.PROTOCOL_ROLES,
    profiles: actors.SEMANTIC_PROFILES,
    toolCalls: actors.TOOL_CALLS,
    toolResultClasses: actors.TOOL_RESULT_CLASSES,
  };
  return {
    vocabularyDigest: sha256Of(canonicalJson(document)),
    actorsModuleDigest: sha256File(join(REPO_ROOT, 'dist', 'workflow-kernel', 'testing', 'actors.js')),
    scriptedChannelDigest: sha256File(join(REPO_ROOT, 'dist', 'workflow-kernel', 'development', 'actors.js')),
  };
}

/** The PromptBudgetProfile digest - the exact profile object the runs pin,
 *  hashed with the runtime's own formula (support.sharedTransport:
 *  sha256(JSON.stringify(profile))). */
export async function promptBudgetProfile() {
  const support = await import(pathToFileURL(join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'support.mjs')).href);
  const { pins, profile } = await support.admissionPins();
  const runtimeDigest = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  return {
    runtimeDigest,
    profileRef: 'content://prompt-budget-profiles/development-factory-2026-08',
    providerModelLimitTableRef: profile.providerModelLimitTableRef,
    providerContextLimitTokens: profile.providerContextLimitTokens,
    maxProviderRequests: profile.maxProviderRequests,
    schemaFileDigest: sha256File(join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'prompt-budget-profile.schema.json')),
    positiveFinite: profile.maxTotalInputTokens > 0 && Number.isFinite(profile.maxTotalInputTokens),
  };
}

/** The token-counter identity (the running counter the receipts pin). */
export async function tokenCounter() {
  const envelope = await importDist('workflow-kernel/context-envelope/index.js');
  return { identity: envelope.RUNNING_COUNTER_IDENTITY, digest: sha256Of(canonicalJson(envelope.RUNNING_COUNTER_IDENTITY)) };
}

/** The admission digests: admissionContractDigest recomputed with the
 *  validator's OWN formula (tools/validate-ek-admission-specs.mjs) and the
 *  preserved EK admission-receipt file digest. */
export function admissionDigests() {
  const SPECS = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs');
  const specFiles = {
    complexityBudget: join(SPECS, 'complexity-budget.json'),
    complexityDriver: join(SPECS, 'measure-complexity.mjs'),
    roleContractSchema: join(SPECS, 'canonical-role-contract.schema.json'),
    roleManifest: join(SPECS, 'role-contract-manifest.json'),
    roleValidator: join(SPECS, 'validate-role-contract.mjs'),
    promptBudgetSchema: join(SPECS, 'prompt-budget-profile.schema.json'),
    contextClassification: join(SPECS, 'context-source-classification.json'),
    promptValidator: join(SPECS, 'validate-prompt-budget.mjs'),
    transitionUniverse: join(SPECS, 'frozen-inputs', 'transition-universe.json'),
  };
  const digests = Object.fromEntries(Object.entries(specFiles).map(([key, file]) => [key, sha256File(file)]));
  const validatorDigest = sha256File(join(REPO_ROOT, 'tools', 'validate-ek-admission-specs.mjs'));
  const canonical = canonicalJson({ digests, validator: validatorDigest });
  return {
    admissionContractDigest: sha256Of(canonical),
    specificationDigests: digests,
    validatorDigest,
    ekAdmissionReceiptDigest: sha256File(join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'EK-ADMISSION-RECEIPT.json')),
  };
}

/** The capsule the development-series runs import (same capsule every run). */
export async function capsuleIdentity() {
  const support = await import(pathToFileURL(join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'support.mjs')).href);
  const capsule = await support.buildCapsuleFixture();
  return {
    lineageId: support.LINEAGE.lineageId,
    parentLifecycleRef: support.LINEAGE.parentLifecycleRef,
    capsuleDigest: sha256Of(JSON.stringify(capsule)),
    packageBytesDigest: sha256Of(support.CAPSULE_BYTES.toString('utf8')),
  };
}

/** The scenario-universe fixture digests (corpus + qualify fixtures). */
function scenarioUniverseFixtureDigests() {
  const roots = {
    corpusDescriptors: join(REPO_ROOT, 'tests', 'project-corpus', 'projects'),
    corpusFixtures: join(REPO_ROOT, 'tests', 'project-corpus', 'fixtures'),
    simpleServerFixture: join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server'),
    qualifyFixtures: join(REPO_ROOT, 'tools', 'qualify', 'fixtures'),
    eliteEvidenceKit: join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'elite-evidence-kit'),
  };
  const digests = {};
  for (const [name, root] of Object.entries(roots)) {
    const files = [];
    const walk = (dir, prefix = '') => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.isFile()) files.push(`${rel}\0${sha256File(join(dir, entry.name))}\n`);
      }
    };
    walk(root);
    digests[name] = createHash('sha256').update(files.sort().join('')).digest('hex');
  }
  return digests;
}

/* ------------------------------------------------------------------ */
/* Freeze + verify                                                     */
/* ------------------------------------------------------------------ */

/** Collect the full kit core (everything the kitId covers). */
export async function collectKitCore(seed = DEFAULT_SEED) {
  const tree = collectTree();
  if (!tree.clean) {
    throw Object.assign(
      new Error(`QUALIFY_DIRTY_TREE: ${tree.dirty.length} uncommitted entr${tree.dirty.length === 1 ? 'y' : 'ies'}: ${tree.dirty.map((line) => line.trim()).join(' | ')} - commit before freezing a kit`),
      { code: 'QUALIFY_DIRTY_TREE' },
    );
  }
  const dist = distTreeHash();
  const schema = await importDist('workflow-kernel/persistence/schema.js');
  const universe = await universeDigest();
  const actor = await actorVersion();
  const budget = await promptBudgetProfile();
  const counter = await tokenCounter();
  const admission = admissionDigests();
  const installed = installedPackageDigests();
  const capsule = await capsuleIdentity();
  return {
    kitKind: KIT_KIND,
    kitVersion: KIT_VERSION,
    source: {
      head: tree.head,
      packageJsonDigest: sha256File(join(REPO_ROOT, 'package.json')),
      packageLockDigest: installed.lockDigest,
    },
    build: { distFileCount: dist.fileCount, distTreeHash: dist.treeHash },
    kernel: {
      schemaFingerprint: schema.SCHEMA_FINGERPRINT,
      protocolId: schema.PROTOCOL_ID,
      schemaVersion: schema.SCHEMA_VERSION,
      universeDigest: universe.digest,
      universeSchemaVersion: universe.schemaVersion,
      universeCommandCount: universe.commandCount,
      actorVersion: actor.vocabularyDigest,
      actorModulesDigest: sha256Of(canonicalJson({ actors: actor.actorsModuleDigest, channel: actor.scriptedChannelDigest })),
      complexityBudgetDigest: sha256File(join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'complexity-budget.json')),
      roleContractManifestDigest: sha256File(join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'role-contract-manifest.json')),
      promptBudgetProfileDigest: budget.runtimeDigest,
      promptBudgetProfileRef: budget.profileRef,
      promptBudgetSchemaDigest: budget.schemaFileDigest,
      tokenCounterIdentityDigest: counter.digest,
    },
    packages: installed.packages,
    admission: {
      admissionContractDigest: admission.admissionContractDigest,
      validatorDigest: admission.validatorDigest,
      ekAdmissionReceiptDigest: admission.ekAdmissionReceiptDigest,
    },
    capsule,
    scenarioUniverse: scenarioUniverseFixtureDigests(),
    seed,
  };
}

/** kitId = sha256(canonical(core)) - the content address. */
export const kitIdOf = (core) => sha256Of(canonicalJson(core));

/** Resolve a --kit argument (path or kitId) to its manifest file. */
export function resolveKitPath(reference) {
  if (reference === undefined) throw new Error('QUALIFY_KIT_REQUIRED: pass --kit <path-or-id>');
  if (existsSync(reference)) return reference;
  const byId = join(KITS_DIR, `${reference}.json`);
  if (existsSync(byId)) return byId;
  throw Object.assign(new Error(`QUALIFY_KIT_NOT_FOUND: no kit manifest at ${reference} or ${byId}`), { code: 'QUALIFY_KIT_NOT_FOUND' });
}

export function loadKit(reference) {
  const path = resolveKitPath(reference);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.kitKind !== KIT_KIND || manifest.kitVersion !== KIT_VERSION) {
    throw Object.assign(new Error(`QUALIFY_KIT_UNREADABLE: ${path} is not a ${KIT_KIND} v${KIT_VERSION} document`), { code: 'QUALIFY_KIT_UNREADABLE' });
  }
  return { path, manifest };
}

/**
 * Verify a kit manifest against the LIVE tree: re-collect every digest and
 * refuse on ANY drift (typed per-item drift list). This is the fence every
 * driver runs before starting.
 */
export async function verifyKit(reference) {
  const { path, manifest } = loadKit(reference);
  const drift = [];
  const tree = collectTree();
  if (!tree.clean) drift.push({ kind: 'dirty-tree', detail: `uncommitted entries: ${tree.dirty.map((line) => line.trim()).join(' | ')}` });
  if (tree.head !== manifest.source.head) drift.push({ kind: 'git-head', detail: `expected HEAD ${manifest.source.head}, observed ${tree.head}` });

  const dist = distTreeHash();
  if (dist.treeHash !== manifest.build.distTreeHash || dist.fileCount !== manifest.build.distFileCount) {
    drift.push({ kind: 'dist', detail: `expected dist tree ${manifest.build.distTreeHash.slice(0, 12)} (${manifest.build.distFileCount} files), observed ${dist.treeHash.slice(0, 12)} (${dist.fileCount} files)` });
  }

  const schema = await importDist('workflow-kernel/persistence/schema.js');
  if (schema.SCHEMA_FINGERPRINT !== manifest.kernel.schemaFingerprint) {
    drift.push({ kind: 'schema-fingerprint', detail: `expected ${manifest.kernel.schemaFingerprint}, observed ${schema.SCHEMA_FINGERPRINT}` });
  }

  const universe = await universeDigest();
  if (universe.digest !== manifest.kernel.universeDigest) drift.push({ kind: 'universe', detail: 'the transition-universe vocabulary digest drifted' });

  const actor = await actorVersion();
  if (actor.vocabularyDigest !== manifest.kernel.actorVersion) drift.push({ kind: 'actor-version', detail: 'the actor vocabulary digest drifted' });

  const budget = await promptBudgetProfile();
  if (budget.runtimeDigest !== manifest.kernel.promptBudgetProfileDigest) drift.push({ kind: 'prompt-budget-profile', detail: 'the pinned PromptBudgetProfile digest drifted' });
  if (budget.positiveFinite !== true) drift.push({ kind: 'prompt-budget-profile', detail: 'the pinned PromptBudgetProfile is not positive-finite' });

  const counter = await tokenCounter();
  if (counter.digest !== manifest.kernel.tokenCounterIdentityDigest) drift.push({ kind: 'token-counter', detail: 'the token-counter identity drifted' });

  const admission = admissionDigests();
  if (admission.admissionContractDigest !== manifest.admission.admissionContractDigest) drift.push({ kind: 'admission-contract', detail: 'admissionContractDigest drifted (re-run npm run validate:ek-admission-specs)' });
  if (admission.ekAdmissionReceiptDigest !== manifest.admission.ekAdmissionReceiptDigest) drift.push({ kind: 'ek-admission-receipt', detail: 'the EK admission-receipt file digest drifted' });

  const installed = installedPackageDigests();
  for (const [name, digest] of Object.entries(manifest.packages)) {
    if (installed.packages[name] !== digest) drift.push({ kind: 'package', detail: `installed package ${name} digest drifted` });
  }
  for (const name of Object.keys(installed.packages)) {
    if (manifest.packages[name] === undefined) drift.push({ kind: 'package', detail: `installed package ${name} appeared after the kit freeze` });
  }

  const capsule = await capsuleIdentity();
  if (capsule.capsuleDigest !== manifest.capsule.capsuleDigest) drift.push({ kind: 'capsule', detail: 'the canonical capsule fixture drifted' });

  const fixtures = scenarioUniverseFixtureDigests();
  for (const [name, digest] of Object.entries(manifest.scenarioUniverse)) {
    if (fixtures[name] !== digest) drift.push({ kind: 'scenario-universe', detail: `scenario fixture root "${name}" digest drifted` });
  }

  /* The content address itself: the stored core must hash to the kitId. */
  const { kitId, frozenAt, environment, ...core } = manifest;
  if (kitIdOf(core) !== kitId) {
    drift.push({ kind: 'kit-id', detail: `the manifest content does not hash to its own kitId (${kitId}) - the kit was edited after freezing` });
  }

  if (drift.length > 0) {
    throw Object.assign(
      new Error(`QUALIFY_KIT_DRIFT: kit ${kitId} does not match the live tree (${drift.length} drift item(s)):\n${drift.map((item) => `  [${item.kind}] ${item.detail}`).join('\n')}`),
      { code: 'QUALIFY_KIT_DRIFT', drift, kitId, kitPath: path },
    );
  }
  return { kitId, manifest, kitPath: path };
}

/** Freeze: collect, content-address, write (immutable), return the manifest. */
export async function freezeKit(seed = DEFAULT_SEED) {
  const core = await collectKitCore(seed);
  const kitId = kitIdOf(core);
  mkdirSync(KITS_DIR, { recursive: true });
  const path = join(KITS_DIR, `${kitId}.json`);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    const { kitId: existingId, frozenAt, environment, ...existingCore } = existing;
    if (kitIdOf(existingCore) !== kitId) {
      throw Object.assign(new Error(`QUALIFY_KIT_IMMUTABLE_VIOLATION: ${path} exists with the same id but different content - the kit is immutable; investigate, never edit it`), { code: 'QUALIFY_KIT_IMMUTABLE_VIOLATION' });
    }
    process.stdout.write(`KIT ALREADY FROZEN ${kitId} (immutable): ${path}\n`);
    return { kitId, manifest: existing, kitPath: path };
  }
  const manifest = { ...core, kitId, frozenAt: new Date().toISOString(), environment: await environmentBlock() };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write([
    `KIT FROZEN ${kitId}`,
    `  file: ${path}`,
    `  head: ${manifest.source.head}`,
    `  dist: ${manifest.build.distFileCount} files, tree ${manifest.build.distTreeHash.slice(0, 12)}`,
    `  schema fingerprint: ${manifest.kernel.schemaFingerprint.slice(0, 12)} | universe ${manifest.kernel.universeDigest.slice(0, 12)}`,
    `  actor ${manifest.kernel.actorVersion.slice(0, 12)} | budget profile ${manifest.kernel.promptBudgetProfileDigest.slice(0, 12)} | counter ${manifest.kernel.tokenCounterIdentityDigest.slice(0, 12)}`,
    `  admission ${manifest.admission.admissionContractDigest.slice(0, 12)} | EK receipt ${manifest.admission.ekAdmissionReceiptDigest.slice(0, 12)}`,
    `  seed: ${manifest.seed} | packages: ${Object.keys(manifest.packages).join(', ')}`,
    '',
  ].join('\n'));
  return { kitId, manifest, kitPath: path };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
  };
  const freeze = args.includes('--freeze');
  const verify = args.includes('--verify');
  if (freeze === verify) {
    process.stderr.write('usage: node tools/qualify/kit.mjs --freeze [--seed <uint32>]\n       node tools/qualify/kit.mjs --verify --kit <path-or-id>\n');
    process.exit(2);
  }
  try {
    if (freeze) {
      const seed = value('seed') !== undefined ? Number.parseInt(value('seed'), 10) : DEFAULT_SEED;
      await freezeKit(seed);
    } else {
      const { kitId, kitPath } = await verifyKit(value('kit'));
      process.stdout.write(`KIT VERIFIED ${kitId}: every digest matches the live tree (${kitPath})\n`);
    }
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
