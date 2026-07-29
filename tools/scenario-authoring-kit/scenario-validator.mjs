#!/usr/bin/env node
// scenario-validator v0.1 — read-only LifecycleScenarioManifest validator.
//
// W10-A6 Scenario Authoring Kit (plan §0.13.10, WAVE10-EXTENSIBILITY-SPEC §1).
//
// Validates a scenario `manifest.json` against the §6.x extensibility
// invariants WITHOUT importing any production source. This is the kit's proof
// that a developer can author and validate an arbitrary scenario WITHOUT
// touching the Runtime, global runner, gateway, catalog, or any existing
// module (WAVE10-EXTENSIBILITY-SPEC §0, §3).
//
// Read-only and side-effect-free. Exits non-zero if any rule reports a finding.
//
// The validation core (`validateScenarioManifest`) is exported for in-process
// use by the contract test; the CLI wrapper below just loads a manifest file,
// runs it, and formats the result.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VALIDATOR_VERSION = 'scenario-validator/0.1.0';

// ---------------------------------------------------------------------------
// Rule registry. Each rule: { id, section, desc } + run(manifest) -> Finding[].
// A Finding: { rule, severity: 'error'|'warning', message, path? }.
// ---------------------------------------------------------------------------

const RUNTIME_FIELDS = new Set(['initiatedBy', 'projectId']);

/**
 * Validate a parsed scenario manifest object in-process.
 *
 * @param {any} manifest - the parsed LifecycleScenarioManifest-shaped object.
 * @param {{ moduleOutcomes?: Record<string, string[]> }} [options]
 *   Optional map of module name -> declared outcome codes. When supplied, the
 *   route-completeness rule (V6) checks that every declared module outcome has
 *   a route. When omitted, V6 degrades to a structural check (every stage with
 *   a referenced module has at least one route), which is correct for the
 *   kit's contract test where module packages are not co-located.
 * @returns {{ findings: Finding[], summary: Summary }}
 */
export function validateScenarioManifest(manifest, options = {}) {
  const findings = [];
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    findings.push(err('V0', 'manifest', 'Manifest must be a JSON object.'));
    return { findings, summary: summarize(findings) };
  }

  // ---- V1: top-level required fields (§6.2).
  requireString(findings, manifest, 'manifestFormatVersion', 'manifest');
  requireObject(findings, manifest, 'identity', 'manifest');
  requireObject(findings, manifest, 'inputContract', 'manifest');
  requireObject(findings, manifest, 'outputContract', 'manifest');
  requireString(findings, manifest, 'entryStageId', 'manifest');
  requireStringArray(findings, manifest, 'terminalStatuses', 'manifest');
  requireArray(findings, manifest, 'moduleRefs', 'manifest');
  requireArray(findings, manifest, 'stages', 'manifest');

  // ---- V2: identity shape (§6.2).
  if (isObject(manifest.identity)) {
    requireString(findings, manifest.identity, 'name', 'manifest.identity');
    requireString(findings, manifest.identity, 'version', 'manifest.identity');
    requireString(findings, manifest.identity, 'displayName', 'manifest.identity');
    requireString(findings, manifest.identity, 'description', 'manifest.identity');
    if (manifest.identity.name && !/^[a-z0-9][a-z0-9-]*$/.test(String(manifest.identity.name))) {
      findings.push(err('V2', '§6.2', `identity.name must be kebab-case (lowercase, digits, hyphen); got '${manifest.identity.name}'.`, 'manifest.identity.name'));
    }
    if (manifest.identity.version && !/^\d+\.\d+\.\d+/.test(String(manifest.identity.version))) {
      findings.push(err('V2', '§6.2', `identity.version must be semver-shaped (MAJOR.MINOR.PATCH...); got '${manifest.identity.version}'.`, 'manifest.identity.version'));
    }
  }

  // ---- V3: contracts (§6.2).
  for (const c of ['inputContract', 'outputContract']) {
    if (isObject(manifest[c])) {
      requireString(findings, manifest[c], 'id', `manifest.${c}`, 'V3');
    }
  }

  // ---- V4: NO routeResolver (§6.4). The defining proof of the architecture.
  if ('routeResolver' in manifest || 'resolver' in manifest) {
    findings.push(err('V4', '§6.4', 'Manifest MUST NOT contain a routeResolver/resolver field. Routes are declarative static outcomeRoutes only (no executable closure).', 'manifest'));
  }
  // `source` is informational; if present, `routeResolverPresent` must be false.
  if (manifest.routeResolverPresent === true) {
    findings.push(err('V4', '§6.4', "manifest.routeResolverPresent must be false/absent — proves §6.4 (no executable closures in a LifecycleScenarioManifest).", 'manifest.routeResolverPresent'));
  }

  const stages = Array.isArray(manifest.stages) ? manifest.stages : [];
  const stageIds = new Set(stages.map((s) => s?.id).filter(Boolean));
  const terminalStatuses = new Set(
    Array.isArray(manifest.terminalStatuses) ? manifest.terminalStatuses : [],
  );

  // ---- V5: entry stage exists.
  if (manifest.entryStageId && !stageIds.has(manifest.entryStageId)) {
    findings.push(err('V5', '§6.2', `entryStageId '${manifest.entryStageId}' does not match any stage id.`, 'manifest.entryStageId'));
  }
  // Entry stage must be reachable: it must not be the target of a terminal route only.
  // (Lightweight — full reachability is the runtime's job.)

  // ---- Stage-level rules.
  const seenStageIds = new Set();
  const moduleRefsDeclared = new Set(
    (Array.isArray(manifest.moduleRefs) ? manifest.moduleRefs : [])
      .map((r) => r && typeof r === 'object' ? `${r.name}@${r.version}` : null)
      .filter(Boolean),
  );

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const ctx = `manifest.stages[${i}]`;
    if (!isObject(stage)) {
      findings.push(err('V7', '§6.3', `Stage entry must be an object.`, ctx));
      continue;
    }
    const id = stage.id;
    if (!id || typeof id !== 'string') {
      findings.push(err('V7', '§6.3', `Stage must have a string id.`, ctx));
    } else if (seenStageIds.has(id)) {
      findings.push(err('V7', '§6.3', `Duplicate stage id '${id}'.`, ctx));
    } else {
      seenStageIds.add(id);
    }
    requireString(findings, stage, 'displayName', ctx);
    // moduleRef is an object { name, version } — its required keys are validated by V8.
    if (!isObject(stage.moduleRef)) {
      findings.push(err('V8', '§3.8', `Stage '${id}' must have an object moduleRef { name, version }.`, `${ctx}.moduleRef`));
    }

    // ---- V8: moduleRef references a declared moduleRef (§3.8, §6.2).
    if (stage.moduleRef && typeof stage.moduleRef === 'object') {
      const mr = stage.moduleRef;
      if (typeof mr.name !== 'string' || typeof mr.version !== 'string') {
        findings.push(err('V8', '§3.8', `stage.moduleRef must have string name and version.`, `${ctx}.moduleRef`));
      } else {
        const key = `${mr.name}@${mr.version}`;
        if (moduleRefsDeclared.size > 0 && !moduleRefsDeclared.has(key)) {
          findings.push(err('V8', '§3.8', `stage '${id}' references module '${key}' which is not declared in manifest.moduleRefs.`, `${ctx}.moduleRef`));
        }
      }
    }

    // ---- V9: mappings use safe own-property expressions only (§6.9.5).
    checkMapping(findings, stage.inputMapping, `${ctx}.inputMapping`);
    checkMapping(findings, stage.outputMapping, `${ctx}.outputMapping`);

    // ---- V6 / V10: outcomeRoutes completeness + shape (§6.3.5, §6.9.3, §6.4).
    const routes = stage.outcomeRoutes;
    if (!isObject(routes)) {
      findings.push(err('V6', '§6.3.5', `Stage '${id}' must have an outcomeRoutes object (even single-outcome modules).`, `${ctx}.outcomeRoutes`));
    } else {
      for (const [outcome, route] of Object.entries(routes)) {
        checkRoute(findings, route, outcome, `${ctx}.outcomeRoutes['${outcome}']`, stageIds, terminalStatuses);
      }
      // Completeness against declared module outcomes, if provided.
      const moduleOutcomes = options.moduleOutcomes;
      const refName = stage.moduleRef && typeof stage.moduleRef === 'object' ? stage.moduleRef.name : null;
      if (moduleOutcomes && refName && Array.isArray(moduleOutcomes[refName])) {
        const declared = moduleOutcomes[refName];
        const routed = new Set(Object.keys(routes));
        for (const oc of declared) {
          if (!routed.has(oc)) {
            findings.push(err('V6', '§6.3.5', `Stage '${id}' is missing a route for declared module outcome '${oc}' (complete route table required).`, `${ctx}.outcomeRoutes`));
          }
        }
      }
    }
  }

  // ---- V11: every non-entry stage is reachable from some route (§6.9.3).
  const routedTargets = new Set();
  for (const stage of stages) {
    if (!isObject(stage) || !isObject(stage.outcomeRoutes)) continue;
    for (const route of Object.values(stage.outcomeRoutes)) {
      if (isObject(route) && route.type === 'stage' && typeof route.stageId === 'string') {
        routedTargets.add(route.stageId);
      }
    }
  }
  for (const stage of stages) {
    if (!isObject(stage) || stage.id === manifest.entryStageId) continue;
    if (!routedTargets.has(stage.id)) {
      findings.push(warn('V11', '§6.9.3', `Stage '${stage.id}' is not the target of any stage route and is not the entry stage (unreachable).`, `manifest.stages (id='${stage.id}')`));
    }
  }

  // ---- V12: every terminal status is reachable (§6.2.9).
  const routedStatuses = new Set();
  for (const stage of stages) {
    if (!isObject(stage) || !isObject(stage.outcomeRoutes)) continue;
    for (const route of Object.values(stage.outcomeRoutes)) {
      if (isObject(route) && route.type === 'terminal' && typeof route.status === 'string') {
        routedStatuses.add(route.status);
      }
    }
  }
  for (const ts of terminalStatuses) {
    if (!routedStatuses.has(ts)) {
      findings.push(warn('V12', '§6.2.9', `terminalStatus '${ts}' is not the target of any terminal route.`, 'manifest.terminalStatuses'));
    }
  }

  return { findings, summary: summarize(findings) };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function err(rule, section, message, p) {
  return { rule, severity: 'error', section, message, path: p };
}
function warn(rule, section, message, p) {
  return { rule, severity: 'warning', section, message, path: p };
}

function requireString(findings, obj, key, ctx, rule = 'V1') {
  if (!(key in obj) || typeof obj[key] !== 'string' || obj[key].length === 0) {
    findings.push(err(rule, '§6.2', `Missing or non-string '${key}'.`, `${ctx}.${key}`));
  }
}
function requireObject(findings, obj, key, ctx) {
  if (!isObject(obj[key])) {
    findings.push(err('V1', '§6.2', `Missing or non-object '${key}'.`, `${ctx}.${key}`));
  }
}
function requireArray(findings, obj, key, ctx) {
  if (!Array.isArray(obj[key])) {
    findings.push(err('V1', '§6.2', `Missing or non-array '${key}'.`, `${ctx}.${key}`));
  }
}
function requireStringArray(findings, obj, key, ctx) {
  if (!Array.isArray(obj[key]) || obj[key].some((v) => typeof v !== 'string')) {
    findings.push(err('V1', '§6.2', `'${key}' must be an array of strings.`, `${ctx}.${key}`));
  }
}

/**
 * §6.9.5 — mapping values are safe own-property expressions only:
 *   - a JSON-path string, OR
 *   - { literal: <any> }, OR
 *   - { runtime: 'initiatedBy' | 'projectId' }
 * No other shapes. No expression language.
 */
function checkMapping(findings, mapping, ctx) {
  if (mapping === undefined) return;
  if (!isObject(mapping)) {
    findings.push(err('V9', '§6.9.5', `Mapping must be an object.`, ctx));
    return;
  }
  for (const [key, val] of Object.entries(mapping)) {
    const vctx = `${ctx}['${key}']`;
    if (typeof val === 'string') {
      // path string — must not be empty.
      if (val.length === 0) {
        findings.push(err('V9', '§6.9.5', `Mapping value for '${key}' is an empty path string.`, vctx));
      }
      continue;
    }
    if (isObject(val)) {
      if ('literal' in val) {
        continue; // literal of any JSON value is allowed.
      }
      if ('runtime' in val) {
        const rf = val.runtime;
        if (typeof rf !== 'string' || !RUNTIME_FIELDS.has(rf)) {
          findings.push(err('V9', '§6.9.5', `Mapping value for '${key}' uses runtime field '${rf}'. Allowed runtime fields: ${[...RUNTIME_FIELDS].join(', ')}.`, vctx));
        }
        continue;
      }
      findings.push(err('V9', '§6.9.5', `Mapping value for '${key}' is an object but has neither 'literal' nor a valid 'runtime' key.`, vctx));
      continue;
    }
    findings.push(err('V9', '§6.9.5', `Mapping value for '${key}' must be a path string, { literal }, or { runtime: '${[...RUNTIME_FIELDS].join("'|'")}' }.`, vctx));
  }
}

/**
 * §6.4 — route is a plain static object: { type: 'stage'|'terminal', ... }.
 * No executable closures can be expressed in JSON, but we still verify the
 * shape and that targets resolve to declared stages/statuses.
 */
function checkRoute(findings, route, outcome, ctx, stageIds, terminalStatuses) {
  if (!isObject(route)) {
    findings.push(err('V6', '§6.4', `Route for outcome '${outcome}' must be an object.`, ctx));
    return;
  }
  if (route.type === 'stage') {
    if (typeof route.stageId !== 'string' || route.stageId.length === 0) {
      findings.push(err('V6', '§6.4', `Stage route for outcome '${outcome}' needs a non-empty string stageId.`, ctx));
    } else if (stageIds.size > 0 && !stageIds.has(route.stageId)) {
      findings.push(err('V6', '§6.4', `Stage route for outcome '${outcome}' targets unknown stage '${route.stageId}'.`, ctx));
    }
  } else if (route.type === 'terminal') {
    if (typeof route.status !== 'string' || route.status.length === 0) {
      findings.push(err('V6', '§6.4', `Terminal route for outcome '${outcome}' needs a non-empty string status.`, ctx));
    } else if (terminalStatuses.size > 0 && !terminalStatuses.has(route.status)) {
      findings.push(err('V6', '§6.2.9', `Terminal route for outcome '${outcome}' targets status '${route.status}' not declared in terminalStatuses.`, ctx));
    }
  } else {
    findings.push(err('V6', '§6.4', `Route for outcome '${outcome}' has invalid type '${route.type}'; expected 'stage' or 'terminal'.`, ctx));
  }
}

function summarize(findings) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  return {
    ok: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    byRule,
  };
}

// ---------------------------------------------------------------------------
// Public rule catalogue (for --help and introspection).
// ---------------------------------------------------------------------------

export const RULES = Object.freeze([
  { id: 'V0', section: '§6.2', desc: 'Manifest is a JSON object.' },
  { id: 'V1', section: '§6.2', desc: 'Top-level required fields present and correctly typed.' },
  { id: 'V2', section: '§6.2', desc: 'identity.name kebab-case, identity.version semver-shaped.' },
  { id: 'V3', section: '§6.2', desc: 'inputContract.id / outputContract.id present.' },
  { id: 'V4', section: '§6.4', desc: 'No routeResolver/resolver field; routeResolverPresent must be false/absent (the core §6.4 proof).' },
  { id: 'V5', section: '§6.2', desc: 'entryStageId resolves to a declared stage.' },
  { id: 'V6', section: '§6.3.5/§6.4', desc: 'outcomeRoutes present per stage; every route is a static stage/terminal object; declared module outcomes are all routed.' },
  { id: 'V7', section: '§6.3', desc: 'Each stage is an object with a unique string id.' },
  { id: 'V8', section: '§3.8', desc: 'Each stage.moduleRef is declared in manifest.moduleRefs.' },
  { id: 'V9', section: '§6.9.5', desc: 'Mapping values are path strings, { literal }, or { runtime: <allowed> } only.' },
  { id: 'V11', section: '§6.9.3', desc: 'Every non-entry stage is reachable (warning).' },
  { id: 'V12', section: '§6.2.9', desc: 'Every terminalStatus is reachable (warning).' },
]);

// ---------------------------------------------------------------------------
// CLI wrapper.
// ---------------------------------------------------------------------------

function usage() {
  const ruleLines = RULES.map((r) => `  ${r.id}  ${r.section} — ${r.desc}`).join('\n');
  return [
    `${VALIDATOR_VERSION} — read-only LifecycleScenarioManifest validator.`,
    '',
    'W10-A6 Scenario Authoring Kit (plan §0.13.10, WAVE10-EXTENSIBILITY-SPEC).',
    '',
    'Usage:',
    '  node scenario-validator.mjs <manifest.json> [--json]',
    '',
    'Validates a scenario manifest against the §6.x extensibility invariants',
    'WITHOUT importing any production source. Exits non-zero on any error.',
    '',
    'Rules:',
    ruleLines,
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    return { help: true };
  }
  let format = 'text';
  let manifestPath = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') format = 'json';
    else if (a === '-h' || a === '--help') return { help: true };
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else {
      if (manifestPath) throw new Error(`unexpected extra positional: ${a}`);
      manifestPath = a;
    }
  }
  if (!manifestPath) throw new Error('missing required positional: <manifest.json>');
  return { manifestPath, format, help: false };
}

function formatText(result, manifestPath) {
  const { findings, summary } = result;
  const lines = [];
  lines.push(`${VALIDATOR_VERSION} — ${manifestPath}`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('  No findings. Manifest satisfies all §6.x invariants.');
  } else {
    for (const f of findings) {
      const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
      const at = f.path ? `  @ ${f.path}` : '';
      lines.push(`  ${tag} [${f.rule} ${f.section}] ${f.message}${at}`);
    }
  }
  lines.push('');
  lines.push(`  ${summary.errors} error(s), ${summary.warnings} warning(s). ok=${summary.ok}`);
  return lines.join('\n');
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${usage()}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  let raw;
  try {
    raw = readFileSync(opts.manifestPath, 'utf8');
  } catch (e) {
    process.stderr.write(`Cannot read manifest '${opts.manifestPath}': ${e.message}\n`);
    return 2;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Manifest is not valid JSON: ${e.message}\n`);
    return 2;
  }
  const result = validateScenarioManifest(manifest);
  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify({ validator: VALIDATOR_VERSION, manifestPath: path.resolve(opts.manifestPath), ...result }, null, 2) + '\n');
  } else {
    process.stdout.write(formatText(result, opts.manifestPath) + '\n');
  }
  return result.summary.ok ? 0 : 1;
}

// Run only when invoked directly (not when imported by tests). Uses
// fileURLToPath for an OS-independent comparison (the naive file:// strip is
// wrong on Windows, where import.meta.url is file:///D:/... ).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv);
  process.exitCode = code;
}
