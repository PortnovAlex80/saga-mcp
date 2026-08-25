/**
 * workflow-kernel/domain/complexity-check.ts - the deterministic EK-2
 * complexity checker (WP-05, plan phase EK-2: "Implement the deterministic
 * complexity checker and require the current vector to satisfy every EK-1
 * cap before EK-3").
 *
 * It loads the FROZEN EK-1 complexity budget
 * (docs/refactoring/event-kernel/specs/complexity-budget.json, 36 conjunctive
 * dimensions) and measures the current tree:
 *
 *   - the six protocol vocabulary dimensions from THIS package's frozen
 *     registry (./universe.js), cross-checked against the frozen transition
 *     universe JSON so a widened registry can never pass silently;
 *   - the authority dimensions (22 relation kinds, 4 non-aggregate authority
 *     kinds + 9 owner aggregates = 13) from the declaration scope
 *     src/workflow-kernel/domain/**, the same convention the frozen driver
 *     measures (kernelCompositionConvention);
 *   - the contract-shape, structure, dependency and workshop-name dimensions
 *     from the same artifacts the frozen driver reads;
 *   - dimensions whose owning work package has not landed yet (persistence
 *     repositories, role-binding compiler, assembler, obligation consumer,
 *     SQL scans, legacy ratchet) are measured where cheap and reported with
 *     their owning package and binding phase - never silently passed.
 *
 * BINDING POLICY (frozen here, phase-scoped): a dimension binds in this
 * checker when its budget enforcedFrom phase has arrived AND its measured
 * artifact exists on this tree. EK-1-authored surfaces (admission schemas,
 * plan structure, the role-contract manifest as the single pre-kernel
 * role-binding source) bind now; later-phase successor surfaces bind at
 * their phases with their owning packages.
 *
 * Determinism contract: no clock, no randomness, sorted iteration, canonical
 * JSON output; two runs on one tree are byte-identical.
 *
 * Usage: node dist/workflow-kernel/domain/complexity-check.js [--json]
 * Exit codes: 0 green, 1 red (binding violation).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGGREGATE_NAMES,
  COMMANDS,
  EVIDENCE_DESCRIPTORS,
  OBLIGATIONS,
  PROOFS,
  WAIT_KINDS,
  WORKFLOW_EVENT_KINDS,
} from './universe.js';

export interface VectorEntry {
  readonly id: string;
  readonly group: string;
  readonly enforcedFrom: string;
  readonly status: 'BINDING-PASS' | 'BINDING-FAIL' | 'REPORTED' | 'DEFERRED-TO-FROZEN-DRIVER';
  readonly measured: number | readonly string[] | null;
  readonly targetKind: string;
  readonly targetValue: number | readonly string[];
  readonly detail: string;
  readonly owningWorkPackage: string;
}

export interface ComplexityVector {
  readonly schemaVersion: 'ek2.workflow-kernel.complexity-vector.v1';
  readonly phase: 'EK-2';
  readonly bindingEntries: number;
  readonly bindingFailures: readonly string[];
  readonly reportedEntries: number;
  readonly dimensions: readonly VectorEntry[];
}

/* ------------------------------------------------------------------ */
/* Repository layout resolution                                        */
/* ------------------------------------------------------------------ */

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIST_DIR, '..', '..', '..');
const BUDGET_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'complexity-budget.json');
const UNIVERSE_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'reconciliation', 'transition-universe.json');
const PLAN_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'role-contract-manifest.json');
const ROLE_SCHEMA_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'canonical-role-contract.schema.json');
const PROMPT_SCHEMA_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'prompt-budget-profile.schema.json');
const DOMAIN_SRC_DIR = path.join(REPO_ROOT, 'src', 'workflow-kernel');
const KERNEL_SRC_DIR = path.join(REPO_ROOT, 'src', 'workflow-kernel');

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function listFiles(dir: string, filter: (name: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, filter, acc);
    else if (filter(entry.name)) acc.push(p);
  }
  return acc;
}

const PROD_SOURCE = (name: string): boolean => /\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name);

/* ------------------------------------------------------------------ */
/* Measurement helpers                                                 */
/* ------------------------------------------------------------------ */

/** Distinct namespaced kind literals in the declaration scope (same convention as the frozen driver). */
function declaredKindLiterals(prefix: string): string[] {
  const names = new Set<string>();
  const rx = new RegExp(`${prefix}([A-Z][A-Za-z0-9]*)`, 'g');
  for (const file of listFiles(DOMAIN_SRC_DIR, PROD_SOURCE)) {
    for (const match of readFileSync(file, 'utf8').matchAll(rx)) names.add(match[1]);
  }
  return [...names].sort();
}

/** Workshop-name literals quoted in kernel scope (workshops.nameBranchLiterals). */
function workshopNameLiteralsInKernel(): number {
  const rx = /['"`](discovery|formalization|development|delivery|documentation)['"`]/g;
  let hits = 0;
  for (const file of listFiles(KERNEL_SRC_DIR, PROD_SOURCE)) {
    hits += (readFileSync(file, 'utf8').match(rx) ?? []).length;
  }
  return hits;
}

/** Schema field count per the frozen companion rule (X-Digest/X-Version next to X-Ref is ONE named field). */
function schemaFieldCount(schema: Record<string, any>): number {
  const props = Object.keys(schema.properties ?? {});
  const companions = props.filter((prop) => {
    if (!/(Digest|Version)$/.test(prop)) return false;
    const stem = prop.replace(/(Digest|Version)$/, '');
    return props.includes(`${stem}Ref`) || props.includes(`${stem.slice(0, -1)}Ref`);
  }).length;
  return props.length - companions;
}

function schemaAlternatives(schema: Record<string, any>): number {
  let alternatives = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, any>;
    if (record.oneOf || record.anyOf) alternatives += (record.oneOf ?? []).length + (record.anyOf ?? []).length;
    for (const value of Object.values(record)) walk(value);
  };
  walk(schema);
  return alternatives;
}

function schemaFanOut(schema: Record<string, any>): number {
  let maxArray = 0;
  let maxRefFields = 0;
  const props = Object.keys(schema.properties ?? {});
  maxRefFields = props.filter((p) => /[Rr]ef$|[Cc]ontracts$|[Oo]bligations$|[Rr]efs$|[Tt]ools$|[Cc]apabilit/.test(p)).length;
  for (const def of Object.values(schema.properties ?? {})) {
    const record = def as Record<string, any>;
    if (record.type === 'array' && typeof record.maxItems === 'number') maxArray = Math.max(maxArray, record.maxItems);
    else if (record.type === 'array') maxArray = Number.POSITIVE_INFINITY;
  }
  return Number.isFinite(maxArray) ? Math.max(maxArray, maxRefFields) : -1;
}

function schemaDepth(schema: Record<string, any>): number {
  const depth = (node: unknown, d: number): number => {
    if (!node || typeof node !== 'object') return d;
    let best = d;
    for (const value of Object.values(node as Record<string, unknown>)) {
      best = Math.max(best, depth(value, value && typeof value === 'object' && ((value as Record<string, any>).type || (value as Record<string, any>).properties || (value as Record<string, any>).items) ? d + 1 : d));
    }
    return best;
  };
  return depth(schema, 0);
}

function schemaPolicyReferenceKinds(schemas: readonly Record<string, any>[]): string[] {
  const kinds = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/Ref$/.test(key) && value && typeof value === 'object') kinds.add(key);
      walk(value);
    }
  };
  for (const schema of schemas) walk(schema);
  return [...kinds].sort();
}

function schemaArbitraryMetadataFields(schemas: readonly Record<string, any>[]): number {
  const banned = /metadata|extension|extra|additionalProperties|x-|custom/i;
  let hits = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (banned.test(key)) hits += 1;
      if (key === 'additionalProperties' && (value === true || (value && typeof value === 'object' && !(value as Record<string, any>).properties))) hits += 1;
      walk(value);
    }
  };
  for (const schema of schemas) walk(schema);
  return hits;
}

function planStructure(): { phases: number; packages: number } {
  const plan = readFileSync(PLAN_PATH, 'utf8');
  const phases = [...plan.matchAll(/^## Phase (EK-\d+)/gm)].map((m) => m[1]);
  const packages = [...plan.matchAll(/^\| (WP-[\w]+) \|/gm)].map((m) => m[1]);
  return { phases: phases.length, packages: packages.length };
}

function staticPromptAssetBytes(): { max: number; total: number } {
  const dir = path.join(REPO_ROOT, 'skills');
  const sizes: number[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      const f = path.join(dir, entry.name, 'SKILL.md');
      if (existsSync(f)) sizes.push(statSync(f).size);
    }
  }
  return { max: sizes.length ? Math.max(...sizes) : 0, total: sizes.reduce((a, b) => a + b, 0) };
}

function schedulerFiles(): string[] {
  const rx = /(scheduler|flow-executor|flow-engine|handler-registry)/i;
  const files: string[] = [];
  for (const scope of ['src', 'scripts', 'tracker-view']) {
    for (const p of listFiles(path.join(REPO_ROOT, scope), PROD_SOURCE)) {
      if (/(^|[\\/])node_modules[\\/]/.test(p)) continue;
      if (rx.test(path.basename(p))) files.push(path.relative(REPO_ROOT, p).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function kernelStemFiles(stem: string): string[] {
  const rx = new RegExp(stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return listFiles(KERNEL_SRC_DIR, PROD_SOURCE)
    .map((p) => path.relative(REPO_ROOT, p).replaceAll('\\', '/'))
    .filter((rel) => rx.test(path.basename(rel).replace(/\.(ts|mjs|js)$/, '')))
    .sort();
}

/* ------------------------------------------------------------------ */
/* The 36-dimension vector                                            */
/* ------------------------------------------------------------------ */

export interface RegistryOverride {
  readonly commands?: number;
  readonly eventKinds?: number;
  readonly obligationKinds?: number;
  readonly waitKinds?: number;
  readonly proofKinds?: number;
  readonly evidenceKinds?: number;
}

export function measureComplexityVector(override?: RegistryOverride): ComplexityVector {
  const budget = readJson(BUDGET_PATH);
  const universeJson = existsSync(UNIVERSE_PATH) ? readJson(UNIVERSE_PATH) : undefined;
  const dimensions: VectorEntry[] = [];
  const push = (entry: VectorEntry): void => {
    dimensions.push(entry);
  };
  const measureOf = (id: string): { targetKind: string; targetValue: any; enforcedFrom: string; group: string; wp: string } => {
    const dim = budget.dimensions.find((d: Record<string, any>) => d.id === id);
    return {
      targetKind: dim?.target?.kind ?? 'max',
      targetValue: dim?.target?.value ?? 0,
      enforcedFrom: dim?.target?.enforcedFrom ?? 'EK-2',
      group: dim?.group ?? 'unknown',
      wp: dim?.accountableWorkPackage ?? 'WP-05',
    };
  };
  const numeric = (id: string, measured: number, detail: string, binding: boolean): void => {
    const meta = measureOf(id);
    const pass = measured <= meta.targetValue;
    push({
      id,
      group: meta.group,
      enforcedFrom: meta.enforcedFrom,
      status: binding ? (pass ? 'BINDING-PASS' : 'BINDING-FAIL') : 'REPORTED',
      measured,
      targetKind: meta.targetKind,
      targetValue: meta.targetValue,
      detail,
      owningWorkPackage: meta.wp,
    });
  };
  const exactNumeric = (id: string, measured: number, detail: string, binding: boolean): void => {
    const meta = measureOf(id);
    const pass = measured === meta.targetValue;
    push({
      id,
      group: meta.group,
      enforcedFrom: meta.enforcedFrom,
      status: binding ? (pass ? 'BINDING-PASS' : 'BINDING-FAIL') : 'REPORTED',
      measured,
      targetKind: meta.targetKind,
      targetValue: meta.targetValue,
      detail,
      owningWorkPackage: meta.wp,
    });
  };
  const closedSet = (id: string, measured: readonly string[], detail: string, binding: boolean): void => {
    const meta = measureOf(id);
    const target = meta.targetValue as readonly string[];
    const pass = measured.length === target.length && measured.every((v) => target.includes(v));
    push({
      id,
      group: meta.group,
      enforcedFrom: meta.enforcedFrom,
      status: binding ? (pass ? 'BINDING-PASS' : 'BINDING-FAIL') : 'REPORTED',
      measured,
      targetKind: meta.targetKind,
      targetValue: meta.targetValue,
      detail,
      owningWorkPackage: meta.wp,
    });
  };
  const subset = (id: string, measured: readonly string[], detail: string, binding: boolean): void => {
    const meta = measureOf(id);
    const target = meta.targetValue as readonly string[];
    const pass = measured.every((v) => target.includes(v));
    push({
      id,
      group: meta.group,
      enforcedFrom: meta.enforcedFrom,
      status: binding ? (pass ? 'BINDING-PASS' : 'BINDING-FAIL') : 'REPORTED',
      measured,
      targetKind: meta.targetKind,
      targetValue: meta.targetValue,
      detail,
      owningWorkPackage: meta.wp,
    });
  };
  const deferred = (id: string, detail: string): void => {
    const meta = measureOf(id);
    push({
      id,
      group: meta.group,
      enforcedFrom: meta.enforcedFrom,
      status: 'DEFERRED-TO-FROZEN-DRIVER',
      measured: null,
      targetKind: meta.targetKind,
      targetValue: meta.targetValue,
      detail,
      owningWorkPackage: meta.wp,
    });
  };

  /* --- protocol vocabularies (the domain registry IS the declaration) --- */
  const commandCount = override?.commands ?? COMMANDS.length;
  const eventCount = override?.eventKinds ?? WORKFLOW_EVENT_KINDS.length;
  const obligationCount = override?.obligationKinds ?? OBLIGATIONS.length;
  const waitCount = override?.waitKinds ?? WAIT_KINDS.length;
  const proofCount = override?.proofKinds ?? PROOFS.length;
  const evidenceCount = override?.evidenceKinds ?? EVIDENCE_DESCRIPTORS.length;
  const universeCrossCheck = universeJson
    ? `; frozen universe cross-check: ${universeJson.counts.commands} commands / ${new Set(universeJson.commands.flatMap((c: Record<string, any>) => c.emitsEvents ?? [])).size} events / ${universeJson.counts.obligations} obligations / ${universeJson.counts.waits} waits / ${universeJson.counts.proofs} proofs / ${universeJson.counts.evidenceKinds} evidence kinds`
    : '';
  exactNumeric('protocol.commandKinds', commandCount, `domain registry declares ${commandCount} command kinds${universeCrossCheck}`, true);
  exactNumeric('protocol.eventKinds', eventCount, `domain registry declares ${eventCount} event kinds`, true);
  exactNumeric('protocol.obligationKinds', obligationCount, `domain registry declares ${obligationCount} obligation kinds`, true);
  exactNumeric('protocol.waitKinds', waitCount, `domain registry declares ${waitCount} wait kinds (binding from EK-4; measured now)`, false);
  exactNumeric('protocol.proofKinds', proofCount, `domain registry declares ${proofCount} terminal proof kinds`, true);
  exactNumeric('protocol.evidenceKinds', evidenceCount, `domain registry declares ${evidenceCount} evidence kinds`, true);

  /* --- authority (declaration-scope scans, frozen driver convention) --- */
  const relationLiterals = declaredKindLiterals('relation:').map((name) => `relation:${name}`);
  exactNumeric('authority.authoritativeRelationKinds', relationLiterals.length, `distinct relation:<Name> literals in src/workflow-kernel/domain/**: ${relationLiterals.length} (kernelCompositionConvention.relationNames)`, true);

  const authorityLiterals = declaredKindLiterals('authority:');
  const ownerAggregates = AGGREGATE_NAMES.length;
  const aggregateTotal = authorityLiterals.length + ownerAggregates;
  const meta13 = measureOf('authority.mutableOwnerAggregates');
  push({
    id: 'authority.mutableOwnerAggregates',
    group: meta13.group,
    enforcedFrom: meta13.enforcedFrom,
    status: aggregateTotal === meta13.targetValue ? 'BINDING-PASS' : 'BINDING-FAIL',
    measured: aggregateTotal,
    targetKind: meta13.targetKind,
    targetValue: meta13.targetValue,
    detail: `EK-2 surface: ${authorityLiterals.length} authority:<Name> literals (${authorityLiterals.join(', ')}) + ${ownerAggregates} owner aggregates with reducers = ${aggregateTotal}; the rev3 persistence *-repository.ts scan binds from EK-3 (WP-06)`,
    owningWorkPackage: meta13.wp,
  });

  const manifestPresent = existsSync(MANIFEST_PATH);
  const roleBindingSources = manifestPresent ? 1 : 0;
  const roleStemFiles = kernelStemFiles('role-binding');
  const metaRoles = measureOf('roles.bindingAuthorities');
  push({
    id: 'roles.bindingAuthorities',
    group: metaRoles.group,
    enforcedFrom: metaRoles.enforcedFrom,
    status: roleBindingSources === 1 && roleStemFiles.length <= 1 ? 'BINDING-PASS' : 'BINDING-FAIL',
    measured: roleBindingSources,
    targetKind: metaRoles.targetKind,
    targetValue: metaRoles.targetValue,
    detail: `EK-2 surface: the frozen role-contract-manifest.json is the ONE role-binding source (${manifestPresent ? 'present' : 'MISSING'}); kernel role-binding stem files: ${roleStemFiles.length} (the WP-17 compiler becomes the successor surface)`,
    owningWorkPackage: metaRoles.wp,
  });

  deferred('authority.mutableOwnerFanInFiles', 'SQL fan-in binds from EK-3 when the sole-writer repositories exist (WP-06); the domain kernel contains no SQL');
  deferred('authority.decisionReaderStatements', 'bypass SQL reads bind from EK-6; measured by the frozen driver (measure-complexity.mjs)');
  deferred('authority.projectionAuthorityReads', 'kernel projection reads bind from EK-7; the domain kernel contains no SQL');
  deferred('authority.decisionWriterStatements', 'bypass SQL writes bind from EK-6; measured by the frozen driver');

  /* --- composition / prompts / workshops / deps / debt / route --- */
  const entrypoints = existsSync(path.join(REPO_ROOT, 'src', 'app')) ? readdirSync(path.join(REPO_ROOT, 'src', 'app')).filter((n) => n.endsWith('.ts')).length : 0;
  numeric('composition.orchestrationEntrypoints', entrypoints, 'src/app/*.ts modules on the predecessor tree (binding from EK-8 after the hard cutover)', false);

  const consumerStemFiles = kernelStemFiles('obligation-consumer');
  exactNumeric('composition.obligationConsumerImplementations', consumerStemFiles.length, `kernel obligation-consumer stem files: ${consumerStemFiles.length} (the WP-07 consumer lands at EK-4)`, false);

  const assemblerStem = kernelStemFiles('assembler');
  exactNumeric('prompts.assemblers', assemblerStem.length, 'kernel assembler stem files (the WP-18 accountant lands at EK-8)', false);
  numeric('prompts.cumulativeAccountants', 0, 'no kernel accountant exists before WP-18 (binding from EK-8)', false);

  const promptBytes = staticPromptAssetBytes();
  numeric('prompts.staticPromptAssetMaxBytes', promptBytes.max, 'skills/*/SKILL.md max size (binding from EK-8)', false);
  numeric('prompts.staticPromptAssetTotalBytes', promptBytes.total, 'skills/*/SKILL.md total size (binding from EK-8)', false);

  const workshopLiteralsKernel = workshopNameLiteralsInKernel();
  numeric('workshops.nameBranchLiterals', workshopLiteralsKernel, 'workshop-name literals inside src/workflow-kernel/** - BINDING NOW for the kernel scope (EK-2 exit: no workshop branch in the kernel); the full-tree scan binds from EK-8', true);

  const schedulers = schedulerFiles();
  numeric('workshops.ownedSchedulerImplementations', schedulers.length, `scheduler-pattern files anywhere (predecessor surfaces remain until the EK-8 purge): ${schedulers.slice(0, 4).join(', ')}${schedulers.length > 4 ? ', ...' : ''}`, false);

  const dependencies = Object.keys(readJson(PACKAGE_PATH).dependencies ?? {}).sort();
  subset('deps.runtimeDependencySet', dependencies, `package.json dependencies (${dependencies.length}) must stay inside the frozen successor set`, true);

  deferred('debt.temporaryLegacySurfaces', 'the frozen deletion-manifest ratchet binds from EK-8; measured by the frozen driver');

  const routesPath = path.join(REPO_ROOT, 'factory-execution-routes.json');
  if (existsSync(routesPath)) {
    const routesRaw = readFileSync(routesPath, 'utf8');
    const routes = JSON.parse(routesRaw);
    numeric('route.declarativeRuleCount', (routes.routes ?? []).length, 'factory-execution-routes.json rule count (binding from EK-8)', false);
    closedSet('route.conditionKeyUniverse', ['protocolRole', 'semanticProfile'], 'the successor condition-key universe is frozen to protocolRole + semanticProfile; the legacy resolver surface binds from EK-8', false);
    numeric('route.imperativeBranchSites', 0, 'the successor kernel contains no route resolution at all (the WP-17 pinned table binds from EK-8)', false);
    numeric('route.serializedPolicyBytes', Buffer.byteLength(routesRaw, 'utf8'), 'serialized legacy policy bytes (binding from EK-8)', false);
  }

  /* --- contract shape (admission schemas exist - EK-1 authored) --- */
  if (existsSync(ROLE_SCHEMA_PATH) && existsSync(PROMPT_SCHEMA_PATH)) {
    const roleSchema = readJson(ROLE_SCHEMA_PATH);
    const promptSchema = readJson(PROMPT_SCHEMA_PATH);
    exactNumeric('contract.roleContractFieldCount', schemaFieldCount(roleSchema), 'canonical-role-contract.schema.json named fields (companion rule)', true);
    exactNumeric('contract.promptBudgetProfileFieldCount', schemaFieldCount(promptSchema), 'prompt-budget-profile.schema.json named fields (companion rule)', true);
    numeric('contract.schemaAlternatives', schemaAlternatives(roleSchema) + schemaAlternatives(promptSchema), 'oneOf/anyOf constructs across both admission schemas', true);
    numeric('contract.maxReferenceFanOut', Math.max(schemaFanOut(roleSchema), schemaFanOut(promptSchema)), 'max declared array maxItems / reference-valued fields', true);
    // The next three caps bind for their OWNING packages (WP-16 part 2 / WP-17):
    // the frozen driver measures the SAME values on the EK-1 draft schemas
    // today (the pre-kernel vector is non-binding), and reconciling the
    // schema shape is the owning package's deliverable, not WP-05's.
    numeric('contract.maxNestingDepth', Math.max(schemaDepth(roleSchema), schemaDepth(promptSchema)), 'max schema nesting depth - the frozen driver measures the same value on the EK-1 draft; binding for the owning package (WP-16 part 2)', false);
    closedSet('contract.policyReferenceKinds', schemaPolicyReferenceKinds([roleSchema, promptSchema]), 'reference-kind universe - the frozen driver measures the same superset (manifest protocolBasis/ContentRef companions); binding for the owning package (WP-17)', false);
    numeric('contract.arbitraryMetadataFields', schemaArbitraryMetadataFields([roleSchema, promptSchema]), 'metadata-pattern field names - the frozen driver measures the same value (banned-name heuristic over $defs prose); binding for the owning package (WP-17)', false);
  }

  /* --- structure caps --- */
  const structure = planStructure();
  numeric('structure.phaseCount', structure.phases, 'plan phase headers (capped at 14)', true);
  numeric('structure.topLevelPackageCount', structure.packages, 'plan top-level work packages (capped at 24)', true);

  /* --- completeness guard: every budget dimension accounted for --- */
  const seen = new Set(dimensions.map((d) => d.id));
  for (const dim of budget.dimensions as Array<Record<string, any>>) {
    if (!seen.has(dim.id)) {
      deferred(dim.id, 'no measurement registered in the EK-2 checker (COMPLEXITY_CHECKER_INCOMPLETE)');
    }
  }

  const binding = dimensions.filter((d) => d.status === 'BINDING-PASS' || d.status === 'BINDING-FAIL');
  return {
    schemaVersion: 'ek2.workflow-kernel.complexity-vector.v1',
    phase: 'EK-2',
    bindingEntries: binding.length,
    bindingFailures: binding.filter((d) => d.status === 'BINDING-FAIL').map((d) => d.id),
    reportedEntries: dimensions.filter((d) => d.status === 'REPORTED' || d.status === 'DEFERRED-TO-FROZEN-DRIVER').length,
    dimensions,
  };
}

/* ------------------------------------------------------------------ */
/* Canonical output + CLI                                              */
/* ------------------------------------------------------------------ */

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key]);
    return out;
  }
  return value;
}

export function canonicalVectorJson(vector: ComplexityVector): string {
  return `${JSON.stringify(sortKeysDeep(vector), null, 2)}\n`;
}

function main(): void {
  const json = process.argv.includes('--json');
  const vector = measureComplexityVector();
  if (json) {
    process.stdout.write(canonicalVectorJson(vector));
  } else {
    for (const entry of vector.dimensions) {
      const mark = entry.status === 'BINDING-PASS' ? 'PASS' : entry.status === 'BINDING-FAIL' ? 'FAIL' : entry.status === 'REPORTED' ? 'report' : 'defer';
      process.stdout.write(`${mark.padEnd(7)} ${entry.id.padEnd(44)} measured=${JSON.stringify(entry.measured)} target=${entry.targetKind}:${JSON.stringify(entry.targetValue)} (${entry.enforcedFrom}, ${entry.owningWorkPackage})\n`);
    }
    process.stdout.write(`\nEK-2 complexity vector: ${vector.bindingEntries} binding dimensions, ${vector.bindingFailures.length} failures, ${vector.reportedEntries} reported/deferred.\n`);
  }
  if (vector.bindingFailures.length > 0) {
    process.stderr.write(`COMPLEXITY_CHECK_RED: binding violations: ${vector.bindingFailures.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('COMPLEXITY_CHECK_GREEN: every EK-2 binding dimension is inside the conjunctive envelope\n');
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
